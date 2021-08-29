// eslint-disable-next-line max-classes-per-file
const path = require('path')
const { v4: uuidv4 } = require('uuid')
const _ = require('lodash')
const debug = require('debug')('discordFS')
const DiscordAPI = require('../discordAPI')
const FileEntry = require('./fileEntry')
const DirectoryEntry = require('./directoryEntry')
const File = require('./file')
const StreamChunker = require('../utils/streamChunker')
const AsyncStreamProcessor = require('../utils/asyncStreamProcessor')
const Util = require('../utils/util')

class DiscordFS {
    /**
     * Create new discord FS
     * @param opts
     */
    constructor(opts) {
        this.channelId = opts.channelId
        this.discordAPI = new DiscordAPI({ token: opts.token, channelId: opts.channelId })

        this.chunkSize = 7864320
        this.files = []
        this.directories = []
        this.uploadLock = new Set()
        this.deleteLock = new Set()

        this.createFile = this.createFile.bind(this)
        this.mkdir = this.mkdir.bind(this)
        this.rm = this.rm.bind(this)
        this.rmdir = this.rmdir.bind(this)
        this.ls = this.ls.bind(this)
    }

    /**
     * Load file index from messages
     * @return {Promise<void>}
     */
    async load() {
        debug('>>> booting discordFS')
        // Load all messages in memory
        const tempMessageCache = []
        let channelMessages = await this.discordAPI.fetchMessages({ limit: 100 })
        while (channelMessages.length > 0) {
            // Parse message content and filter invalid message
            tempMessageCache.push(...channelMessages
                .map((message) => ({ ...message, content: Util.safeParse(message.content) }))
                .filter((message) => message !== undefined))
            // Get next messages
            // eslint-disable-next-line no-await-in-loop
            channelMessages = await this.discordAPI.fetchMessages(
                {
                    limit: 100,
                    before: tempMessageCache[tempMessageCache.length - 1].id,
                },
            )
        }

        const messagesGroupByType = _.groupBy(tempMessageCache, (message) => message.content.type)
        // Channel is empty
        if (!messagesGroupByType.directory) return
        // Load Directories
        messagesGroupByType.directory.forEach((message) => {
            // Create directory entry
            this.directories.push(new DirectoryEntry({
                name: message.content.name,
                mid: message.id,
                id: message.content.id,
                createdAt: new Date(message.timestamp).getTime(),
            }))
        })

        // Load files
        Object.values(_.groupBy(messagesGroupByType.file, (message) => message.content.fileId))
            .forEach((fileParts) => {
                const [firstPart] = fileParts
                // Create file object
                const file = new File({
                    id: firstPart.content.fileId,
                    directoryId: firstPart.content.directoryId,
                    name: firstPart.content.name,
                    createdAt: new Date(firstPart.timestamp).getTime(),
                })
                fileParts.forEach((filePart) => {
                    const [attachment] = filePart.attachments
                    const entry = new FileEntry({
                        directoryId: filePart.content.directoryId,
                        name: file.name,
                        partNumber: filePart.content.partNumber,
                        size: attachment.size,
                        url: attachment.url,
                        mid: filePart.id,
                    })
                    file.parts.push(entry)
                })
                this.files.push(file)
            })
        debug('>>> DiscordFS load complete')
    }

    /**
     * Get directory
     * @param directoryName
     * @return {*}
     */
    getDirectory(directoryName) {
        return this.directories.find((d) => d.name === this.normalizePath(directoryName))
    }

    /**
     * Get file object
     * @param {String} filePath
     * @return {null|*}
     */
    getFile(filePath) {
        const directoryName = this.normalizePath(path.dirname(filePath))
        const fileName = path.basename(filePath)
        const directory = this.directories.find((d) => d.name === directoryName)
        if (directory === null) return null

        return this.files.find((f) => f.directoryId === directory.id && f.name === fileName)
    }

    /**
     * Get child directories
     * @param directoryName
     * @return {*[]}
     */
    getChildDirectories(directoryName) {
        const normalizedDirectoryName = this.normalizePath(directoryName)
        const children = []
        this.directories.forEach((item) => {
            if (item.name !== normalizedDirectoryName && item.name.startsWith(normalizedDirectoryName) && item.name.trim() !== '') {
                let { name } = item
                if (name.indexOf(normalizedDirectoryName) === 0) name = name.substring(normalizedDirectoryName.length)
                if (name.indexOf('/') === 0) name = name.substring(1)
                if (!name.includes('/')) children.push(name)
            }
        })

        return children
    }

    /**
     * Get files for current directory
     * @param directoryName
     * @return {*[]}
     */
    getFiles(directoryName) {
        const directory = this.getDirectory(directoryName)
        if (directory === null) return []

        return this.files.filter((f) => f.directoryId === directory.id)
    }

    /**
     * Upload file from readable stream
     * @param {String} filePath
     * @param stream
     * @return {Promise<unknown>}
     */
    async createFile(filePath, stream) {
        if (this.uploadLock.has(filePath)) this.throwError(`${filePath} upload is already in progress`, 'UPLOAD_IN_PRGORESS')
        else this.uploadLock.add(filePath)
        debug('>> [ADD] in progress :', filePath)

        // Throw error if directory exist on same file path
        const existingDirectory = this.getDirectory(filePath)
        if (existingDirectory) this.throwError(`${filePath} directory exist with same name`, 'DIR_EXIST')

        // Find or create directory
        const directoryName = this.normalizePath(path.dirname(filePath))
        const fileName = path.basename(filePath)
        let directory = this.getDirectory(directoryName)
        if (!directory) directory = await this.mkdir(directoryName)

        // Check if file already exist
        const fileExist = this.files.find((f) => f.directoryId === directory.id && f.name === fileName)
        if (fileExist) throw new Error('File already exist')

        // Create new file and upload
        const file = new File({ directoryId: directory.id, name: fileName, createdAt: Date.now() })
        let partNumber = 0

        // Function to execute on every chunk from stream
        const chunkProcessor = async (chunk) => {
            const entry = await this.createFileChunk(filePath, partNumber, chunk, file.id, directory.id)
            file.parts.push(entry)
            partNumber += 1
        }

        // Delete all messages if file is failed to upload
        const handleAbort = async (cb, err) => {
            await Promise.all(file.parts.map(async (p) => this.discordAPI.deleteMessage(p.mid)))
            this.uploadLock.delete(fileName)
            cb(err)
        }

        // Finally consume stream
        return new Promise((resolve, reject) => {
            stream
                .on('aborted', () => handleAbort(reject)) // On HTTP request abort delete all the messages and reject promise
                .pipe(new StreamChunker(this.chunkSize))
                .pipe(new AsyncStreamProcessor(chunkProcessor))
                .on('finish', () => {
                    this.files.push(file)
                    debug('>> [ADD] completed   :', fileName)
                    this.uploadLock.delete(fileName)
                    resolve(file)
                })
                .on('error', (err) => handleAbort(reject, err))
        })
    }

    /**
     * @private Upload single chunk to discord channel
     * @param {String} filePath
     * @param {Number|String} partNumber
     * @param {Buffer} fileBuffer
     * @param {String} fileId
     * @param {String} directoryId
     * @return {Promise<FileEntry>}
     */
    async createFileChunk(filePath, partNumber, fileBuffer, fileId, directoryId) {
        // Create file entry
        const fileName = path.basename(filePath)
        const entry = new FileEntry({
            fileId, directoryId, name: fileName, partNumber,
        })
        // Upload file part
        const fileAttachment = { fileName: uuidv4(), rawBuffer: fileBuffer }
        const message = await this.discordAPI.createMessage(entry.string, [fileAttachment])
        // Extract file part data
        const [attachment] = message.attachments
        entry.size = attachment.size
        entry.url = attachment.url
        entry.mid = message.id

        return entry
    }

    /**
     * Delete single file
     * @param file
     * @return {Promise<void>}
     */
    async rm(file) {
        debug('>> [RM] in progress :', file.name)
        await Promise.all(
            file.messageIds
                .map(async (messageId) => this.discordAPI.deleteMessage(messageId).catch(() => {})), // PP hihi
        )
        this.files = this.files.filter((f) => f.id !== file.id)
    }

    /**
     * Recursively delete directory
     * @param {String} directoryName
     * @return {Promise<void>}
     */
    async rmdir(directoryName) {
        // TODO : Fix lock
        if (this.deleteLock.has(directoryName)) this.throwError(`${directoryName} delete in progress`, 'DELETE_IN_PROGRESS')
        else this.deleteLock.add(directoryName)
        debug('>> [RMDIR] in progress :', directoryName)
        const directory = this.directories.find((d) => d.name === directoryName)
        if (directory) await this.discordAPI.deleteMessage(directory.mid)
        else return
        this.directories = this.directories.filter((d) => d.id !== directory.id)
        const files = this.files.filter((f) => f.directoryId === directory.id)
        await Promise.all(files.map((file) => this.rm(file)))
        const childDirectories = this.getChildDirectories(directoryName).map((d) => path.normalize(`${directoryName}/${d}`))
        await Promise.all(childDirectories.map(async (d) => this.rmdir(d)))
        this.deleteLock.delete(directoryName)
    }

    /**
     * List files and directories for given directory
     * @param directoryName
     * @return {Object[]}
     */
    ls(directoryName) {
        debug('>> [LS] in progress :', directoryName)
        const files = this.getFiles(directoryName).map((f) => ({
            name: f.name,
            size: f.size,
            createdAt: f.createdAt,
            directory: false,
        }))
        const directories = this.getChildDirectories(directoryName).map((d) => ({ name: d.name, createdAt: d.createdAt, directory: true }))

        return [...files, ...directories]
    }

    /**
     * Recursively create or return new directory
     * @param {String} name
     * @return {Promise<DirectoryEntry|*>}
     */
    async mkdir(name) {
        debug('>> [MKDIR] in progress :', name)
        // Create or return existing directory
        const directoryName = this.normalizePath(name)
        if (name !== '/') {
            const baseDirectory = this.directories.find((d) => d.name === path.dirname(directoryName))
            if (!baseDirectory) await this.mkdir(path.dirname(directoryName))
        }

        const existingDirectory = this.directories.find((d) => d.name === directoryName)
        if (existingDirectory) return existingDirectory

        // Create new Directory
        const entry = new DirectoryEntry({ name: directoryName, createdAt: Date.now() })
        const message = await this.discordAPI.createMessage(entry.string)
        entry.mid = message.id
        this.directories.push(entry)

        return entry
    }

    /**
     * Normalize path
     * @param {String} p
     * @return {string}
     */
    normalizePath(p) {
        let r = path.posix.normalize(p.replace(/\\/g, '/'))
        if (r.endsWith('/') && r !== '/') r = r.slice(0, -1)

        return r.startsWith('/') ? r : `/${r}`
    }

    /**
     * Custom discordFS error
     * @param {String} message
     * @param {String} code
     */
    throwError(message, code) {
        const error = new Error(message)
        error.code = code

        throw error
    }

    /**
     * Get total fs size
     * @return {Number}
     */
    get size() {
        return this.files.reduce((t, f) => t + f.size, 0)
    }
}

module.exports = DiscordFS
