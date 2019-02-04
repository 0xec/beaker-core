const EventEmitter = require('events')
const pump = require('pump')
const concat = require('concat-stream')
const db = require('../dbs/profile-data-db')
const dat = require('../dat')

const READ_TIMEOUT = 30e3

// typedefs
// =

/**
 * @typedef {import('../dat/library').InternalDatArchive} InternalDatArchive
 *
 * @typedef {Object} CrawlSourceRecord
 * @prop {string} id
 * @prop {string} url
 */

// exported api
// =

const crawlerEvents = new EventEmitter()
exports.crawlerEvents = crawlerEvents

/**
 * @param {InternalDatArchive} archive
 * @param {CrawlSourceRecord} crawlSource
 * @param {string} crawlDataset
 * @param {number} crawlDatasetVersion
 * @param {function(Object): Promise<void>} handlerFn
 * @returns {Promise}
 */
exports.doCrawl = async function (archive, crawlSource, crawlDataset, crawlDatasetVersion, handlerFn) {
  const url = archive.url

  // fetch current crawl state
  var resetRequired = false
  var state = await db.get(`
    SELECT crawlSourceVersion, crawlDatasetVersion FROM crawl_sources_meta
      WHERE crawlSourceId = ? AND crawlDataset = ?
  `, [crawlSource.id, crawlDataset])
  if (state && state.crawlDatasetVersion !== crawlDatasetVersion) {
    resetRequired = true
    state = null
  }
  if (!state) {
    state = {crawlSourceVersion: 0, crawlDatasetVersion}
  }

  // fetch current archive version
  var archiveInfo = await dat.library.getDaemon().getArchiveInfo(archive.key)
  var version = archiveInfo ? archiveInfo.version : 0

  // fetch change log
  var start = state.crawlSourceVersion + 1
  var end = version + 1
  console.log('fetching changes', archive.url, start, end, state)
  var changes = await new Promise((resolve, reject) => {
    pump(
      archive.history({start, end, timeout: READ_TIMEOUT}),
      concat({encoding: 'object'}, resolve),
      reject
    )
  })

  crawlerEvents.emit('crawl-dataset-start', {sourceUrl: archive.url, crawlDataset, crawlRange: {start, end}})

  // handle changes
  await handlerFn({changes, resetRequired})

  // final checkpoint
  await doCheckpoint(crawlDataset, crawlDatasetVersion, crawlSource, version)

  crawlerEvents.emit('crawl-dataset-finish', {sourceUrl: archive.url, crawlDataset, crawlRange: {start, end}})
}

/**
 * @param {string} crawlDataset
 * @param {number} crawlDatasetVersion
 * @param {CrawlSourceRecord} crawlSource
 * @param {number} crawlSourceVersion
 * @returns {Promise}
 */
const doCheckpoint = exports.doCheckpoint = async function (crawlDataset, crawlDatasetVersion, crawlSource, crawlSourceVersion) {
  await db.run(`DELETE FROM crawl_sources_meta WHERE crawlDataset = ? AND crawlSourceId = ?`, [crawlDataset, crawlSource.id])
  await db.run(`
    INSERT
      INTO crawl_sources_meta (crawlDataset, crawlDatasetVersion, crawlSourceId, crawlSourceVersion, updatedAt)
      VALUES (?, ?, ?, ?, ?)
  `, [crawlDataset, crawlDatasetVersion, crawlSource.id, crawlSourceVersion, Date.now()])
}

/**
 * @param {string} sourceUrl
 * @param {string} crawlDataset
 * @param {number} progress
 * @param {number} numUpdates
 */
exports.emitProgressEvent = function (sourceUrl, crawlDataset, progress, numUpdates) {
  crawlerEvents.emit('crawl-dataset-progress', {sourceUrl, crawlDataset, progress, numUpdates})
}

/**
 * @param {Array<Object>} changes
 * @param {RegExp} regex
 * @returns {Array<Object>}
 */
exports.getMatchingChangesInOrder = function (changes, regex) {
  var list = [] // order matters, must be oldest to newest
  changes.forEach(c => {
    if (regex.test(c.name)) {
      let i = list.findIndex(c2 => c2.name === c.name)
      if (i !== -1) list.splice(i, 1) // remove from old position
      list.push(c)
    }
  })
  return list
}

/**
 * @returns {string}
 */
var _lastGeneratedTimeFilename
exports.generateTimeFilename = function () {
  var d = Date.now()
  if (d === _lastGeneratedTimeFilename) {
    d++
  }
  _lastGeneratedTimeFilename = d
  return (new Date(d)).toISOString()
}

/**
 * @param {string} url
 * @returns {string}
 */
const toHostname =
exports.toHostname = function (url) {
  var urlParsed = new URL(url)
  return urlParsed.hostname
}

/**
 * @description Helper to determine the thumbUrl for a site description.
 * @param {string} author - (URL) the author of the site description.
 * @param {string} subject - (URL) the site being described.
 * @returns {string} - the URL of the thumbnail.
 */
exports.getSiteDescriptionThumbnailUrl = function (author, subject) {
  return author === subject
    ? `${subject}/thumb` // self-description, use their own thumb
    : `${author}/data/known_sites/${toHostname(subject)}/thumb` // use captured thumb
}
