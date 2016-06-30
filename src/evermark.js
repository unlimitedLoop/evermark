import path from 'path'
import Promise from 'bluebird'
import cheerio from 'cheerio'
import inlineCss from 'inline-css'
import hljs from 'highlight.js'
import Remarkable from 'remarkable'
import { Evernote } from 'evernote'
import fileUtils from './fileUtils'
import EvernoteClient, { OBJECT_NOT_FOUND } from './evernote'
import DB from './db'
import config, { APP_NAME } from './config'

const debug = require('debug')('evermark')

const MARKDOWN_THEME_PATH = `${__dirname}/../themes`
const HIGHLIGHT_THEME_PATH = `${__dirname}/../node_modules/highlight.js/styles`
const DEFAULT_HIGHLIGHT_THEME = 'github'
const DEFAULT_REMARKABLE_OPTIONS = {
  html: true, // Enable HTML tags in source

  // Highlighter function. Should return escaped HTML,
  // or '' if the source string is not changed
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(lang, code).value
      } catch (e) {
        // Ignore
      }
    }

    try {
      return hljs.highlightAuto(code).value
    } catch (e) {
      // Ignore
    }

    return ''
  },
}

export default class Evermark {
  constructor(workDir, options) {
    this.workDir = workDir

    const remarkable = new Remarkable({ ...DEFAULT_REMARKABLE_OPTIONS, ...options })

    // Add inline code class
    const codeRule = remarkable.renderer.rules.code
    remarkable.renderer.rules.code = (...args) => {
      const result = codeRule.call(remarkable, ...args)
      return result.replace('<code>', '<code class="inline">')
    }

    // Add block code class
    const fenceRule = remarkable.renderer.rules.fence
    remarkable.renderer.rules.fence = (...args) => {
      const result = fenceRule.call(remarkable, ...args)
      return result.replace('<pre>', '<pre class="hljs">')
    }

    this.remarkable = remarkable
  }

  async createLocalNote(title) {
    const configDir = await this.getConfigDir()

    // Remove some chars from title
    const filename = title.replace(/(\/|-)+/g, '-').replace(/^-/, '')

    // Get unique note path and create note file
    const notePath = await fileUtils.uniquePath(`${configDir}/notes/${filename}.md`)
    await fileUtils.writeFile(notePath, `# ${title}\n`)

    return notePath
  }

  async publishNote(notePath) {
    const content = await fileUtils.readFile(notePath)
    return this.saveNote(notePath, content)
  }

  async unpublishNote(notePath) {
    const db = await this.getDB()
    const Note = await db.model('notes', {
      guid: { type: String, required: true },
      path: { type: String, required: true },
      created: { type: Date, default: Date.now },
    })

    const { absolutePath, relativePath } = await this.getNotePathInfo(notePath)
    const note = Note.findOne({ path: relativePath })

    if (!note) {
      throw new Error(`${notePath} is not a published note`)
    }

    await this.expungeNote(note.guid)
    await Note.remove({ path: relativePath })
    await db.save()
    return absolutePath
  }

  async saveNote(notePath, content) {
    const note = new Evernote.Note()

    const noteAttrs = new Evernote.NoteAttributes()
    noteAttrs.source = APP_NAME
    noteAttrs.sourceApplication = APP_NAME
    noteAttrs.contentClass = APP_NAME // Make the note read-only
    note.attributes = noteAttrs

    const { absolutePath, relativePath } = await this.getNotePathInfo(notePath)
    note.absolutePath = absolutePath
    note.relativePath = relativePath

    const tokens = this.remarkable.parse(content, {})
    const noteInfo = this.parseNoteInfo(tokens)
    note.title = noteInfo.noteTitle

    if (noteInfo.notebookName) {
      const createdNotebook = await this.createNotebookIfPossible(noteInfo.notebookName)
      note.notebookGuid = createdNotebook.guid
    }

    if (noteInfo.tagNames && noteInfo.tagNames.length) {
      note.tagNames = noteInfo.tagNames
    }

    // The content of an Evernote note is represented using Evernote Markup Language
    // (ENML). The full ENML specification can be found in the Evernote API Overview
    // at http://dev.evernote.com/documentation/cloud/chapters/ENML.php
    const htmlContent = await this.generateHtml(tokens)
    note.content = '<?xml version="1.0" encoding="UTF-8"?>' +
      '<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">' +
      `<en-note>${htmlContent}</en-note>`

    return this.doSaveNote(note)
  }

  async doSaveNote(note) {
    const db = await this.getDB()
    const Note = await db.model('notes', {
      guid: { type: String, required: true },
      path: { type: String, required: true },
      created: { type: Date, default: Date.now },
    })

    let isLocalUpdate = false
    const aNote = note
    const dbNote = Note.findOne({ path: aNote.relativePath })
    if (dbNote) {
      try {
        aNote.guid = dbNote.guid
        const updatedNote = await this.updateNote(aNote)
        updatedNote.absolutePath = aNote.absolutePath
        return updatedNote
      } catch (e) {
        if (e.code === OBJECT_NOT_FOUND) {
          delete aNote.guid
          isLocalUpdate = true
        }
      }
    }

    const createdNote = await this.createNote(aNote)
    createdNote.absolutePath = aNote.absolutePath

    if (isLocalUpdate) {
      await Note.update({ path: aNote.relativePath },
        { guid: createdNote.guid, path: aNote.relativePath })
    } else {
      await Note.insert({ guid: createdNote.guid, path: aNote.relativePath })
    }
    await db.save()

    return createdNote
  }

  async createNotebookIfPossible(name) {
    const notebooks = await this.listNotebooks()
    let notebook = notebooks.find(nb => nb.name === name)
    if (!notebook) {
      notebook = await this.createNotebook(name)
    }
    return notebook
  }

  listNotebooks() {
    return this.getEvernoteClient()
      .then(client => client.listNotebooks())
  }

  createNotebook(name) {
    return this.getEvernoteClient()
      .then(client => client.createNotebook(name))
  }

  createNote(note) {
    return this.getEvernoteClient()
      .then(client => client.createNote(note))
  }

  updateNote(note) {
    return this.getEvernoteClient()
      .then(client => client.updateNote(note))
  }

  expungeNote(guid) {
    return this.getEvernoteClient()
      .then(client => client.expungeNote(guid))
  }

  getEvernoteClient() {
    if (this.evernoteClient) {
      return Promise.resolve(this.evernoteClient)
    }

    return this.getConfig()
      .then(options => {
        this.evernoteClient = new EvernoteClient(options)
        return this.evernoteClient
      })
  }

  getConfig() {
    if (this.config) {
      return Promise.resolve(this.config)
    }

    return config.readConfig(this.workDir)
      .then(conf => {
        this.config = conf
        return conf
      })
  }

  async getConfigDir() {
    const configPath = await config.getConfigPath(this.workDir)
    return path.dirname(configPath)
  }

  getDB() {
    if (this.db) {
      return Promise.resolve(this.db)
    }

    return config.getDbPath(this.workDir)
      .then(dbPath => {
        this.db = new DB(dbPath)
        return this.db
      })
  }

  async getNotePathInfo(notePath) {
    const configDir = await this.getConfigDir()
    const absolutePath = path.isAbsolute(notePath) ?
      notePath : path.resolve(notePath)
    const relativePath = path.relative(configDir, absolutePath)
    debug('absolute notePath: %s', absolutePath)
    debug('relative notePath: %s', relativePath)
    return { absolutePath, relativePath }
  }

  parseNoteInfo(tokens = []) {
    const preTitleIndex = tokens.findIndex(token => token.type === 'heading_open')
    const titleToken = preTitleIndex >= 0 ? tokens[preTitleIndex + 1] : null
    const noteTitle = titleToken ? titleToken.content : 'untitled'

    let notebookName = null
    let tagNames = null
    const notebookToken = tokens.find(token => /^ *@\(.+\)(\[.+\])?$/.test(token.content))
    debug('notebookToken: %o', notebookToken)
    if (notebookToken) {
      const matched = notebookToken.content.trim().match(/^ *@\((.+)\)(\[(.+)\])?$/)
      notebookName = matched[1]
      debug('notebookName: %s', notebookName)

      tagNames = matched[3]
      if (tagNames) {
        tagNames = tagNames
          .split('|')
          .map(s => s.trim())
          .filter(s => !!s)
      }
      debug('tagNames: %o', tagNames)
    }

    return { noteTitle, notebookName, tagNames }
  }

  async generateHtml(tokens = []) {
    const markedHtml = this.remarkable.renderer.render(tokens, this.remarkable.options)
    debug('markedHtml: %s', markedHtml)

    // Get highlight theme from configuration
    const conf = await this.getConfig()
    const highlightTheme = conf.highlight || DEFAULT_HIGHLIGHT_THEME

    // Html with styles
    const styles = await Promise.all([
      fileUtils.readFile(`${MARKDOWN_THEME_PATH}/github.css`),
      fileUtils.readFile(`${HIGHLIGHT_THEME_PATH}/${highlightTheme}.css`),
    ])
    const styleHtml = `<style>${styles[0]}${styles[1]}</style>` +
      `<div class="markdown-body">${markedHtml}</div>`
    debug('styleHtml: %s', styleHtml)

    // Change html classes to inline styles
    const inlineStyleHtml = await inlineCss(styleHtml, {
      url: '/',
      removeStyleTags: true,
      removeHtmlSelectors: true,
    })

    // ENML is a superset of XHTML, so change html to xhtml
    const inlineStyleXhtml = cheerio.load(inlineStyleHtml).xml()
    debug('inlineStyleXhtml: %s', inlineStyleXhtml)
    return inlineStyleXhtml
  }
}
