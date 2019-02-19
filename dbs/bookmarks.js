const assert = require('assert')
const db = require('./profile-data-db')
const normalizeUrl = require('normalize-url')
const lock = require('../lib/lock')
const knex = require('../lib/knex')

const NORMALIZE_OPTS = {
  stripFragment: false,
  stripWWW: false,
  removeQueryParameters: false,
  removeTrailingSlash: false
}

// typedefs
// =

/**
 * @typedef {Object} Bookmark
 * @prop {number} createdAt
 * @prop {string} href
 * @prop {string} title
 * @prop {string[]} tags
 * @prop {boolean} pinned
 * @prop {number} pinOrder
 */

// exported methods
// =

/**
 * @param {number} profileId
 * @param {Object} values
 * @param {string} [values.href]
 * @param {string} [values.title]
 * @param {string | string[]} [values.tags]
 * @param {boolean} [values.pinned]
 * @returns {Promise<void>}
 */
exports.addBookmark = async function (profileId, {href, title, tags, pinned} = {}) {
  // validate
  assertValidHref(href)
  assertValidTitle(title)
  if (tags) assertValidTags(tags)

  // massage values
  href = normalizeUrl(href, NORMALIZE_OPTS)
  var tagsStr = tagsToString(tags)

  // update record
  var release = await lock(`bookmarksdb`)
  try {
    await db.run(`
      INSERT OR REPLACE
        INTO bookmarks (profileId, url, title, tags, pinned)
        VALUES (?, ?, ?, ?, ?)
    `, [profileId, href, title, tagsStr, Number(pinned)])
  } finally {
    release()
  }
}

/**
 * @param {number} profileId
 * @param {string} bookmarkHref
 * @param {Object} values
 * @param {string} [values.href]
 * @param {string} [values.title]
 * @param {string | string[]} [values.tags]
 * @param {boolean} [values.pinned]
 * @returns {Promise<void>}
 */
exports.editBookmark = async function (profileId, bookmarkHref, {href, title, tags, pinned} = {}) {
  // validate
  assertValidHref(bookmarkHref)
  if (href) assertValidHref(href)
  if (title) assertValidTitle(title)
  if (tags) assertValidTags(tags)

  // massage values
  bookmarkHref = normalizeUrl(bookmarkHref, NORMALIZE_OPTS)
  href = href ? normalizeUrl(href, NORMALIZE_OPTS) : undefined
  var tagsStr = tags ? tagsToString(tags) : undefined

  // read, update, store
  var release = await lock(`bookmarksdb`)
  try {
    var oldBookmark = await db.get(`SELECT url, title, pinned, pinOrder FROM bookmarks WHERE profileId = ? AND url = ?`, [profileId, bookmarkHref])

    if (oldBookmark) {
      // update record
      let sql = knex('bookmarks')
        .where({profileId, url: bookmarkHref})
      if (typeof href !== 'undefined') sql = sql.update('url', href)
      if (typeof title !== 'undefined') sql = sql.update('title', title)
      if (typeof tagsStr !== 'undefined') sql = sql.update('tags', tagsStr)
      if (typeof pinned !== 'undefined') sql = sql.update('pinned', Number(pinned))
      await db.run(sql)
    } else {
      // insert record
      await db.run(`
        INSERT OR REPLACE
          INTO bookmarks (profileId, url, title, tags, pinned)
          VALUES (?, ?, ?, ?, ?)
      `, [profileId, href, title, tagsStr, Number(pinned)])
    }
  } finally {
    release()
  }
}

/**
 * @param {number} profileId
 * @param {string} href
 * @returns {Promise<void>}
 */
exports.removeBookmark = async function (profileId, href) {
  href = normalizeUrl(href, NORMALIZE_OPTS)
  var release = await lock(`bookmarksdb`)
  try {
    await db.run(`DELETE FROM bookmarks WHERE profileId = ? AND url = ?`, [profileId, href])
  } finally {
    release()
  }
}

/**
 * @param {number} profileId
 * @param {string[]} urls
 * @returns {Promise<void>}
 */
exports.setBookmarkPinOrder = async function (profileId, urls) {
  var len = urls.length
  var release = await lock(`bookmarksdb`)
  try {
    await Promise.all(urls.map((url, i) => (
      db.run(`UPDATE bookmarks SET pinOrder = ? WHERE profileId = ? AND url = ?`, [len - i, profileId, url])
    )))
  } finally {
    release()
  }
}

/**
 * @param {number} profileId
 * @param {string} url
 * @returns {Promise<Bookmark>}
 */
exports.getBookmark = async function (profileId, href) {
  href = normalizeUrl(href, NORMALIZE_OPTS)
  return toNewFormat(await db.get(`SELECT url, title, tags, pinned, pinOrder, createdAt FROM bookmarks WHERE profileId = ? AND url = ?`, [profileId, href]))
}

/**
 * @param {number} profileId
 * @param {Object} [opts]
 * @param {Object} [opts.filters]
 * @param {string|string[]} [opts.filters.tag]
 * @param {boolean} [opts.filters.pinned]
 * @returns {Promise<Array<Bookmark>>}
 */
exports.listBookmarks = async function (profileId, {filters} = {}) {
  let sql = knex('bookmarks')
    .select('url')
    .select('title')
    .select('tags')
    .select('pinned')
    .select('pinOrder')
    .select('createdAt')
    .where('profileId', '=', profileId)
    .orderBy('createdAt', 'DESC')
  if (filters && filters.pinned) {
    sql = sql.where('pinned', '=', '1')
  }

  var bookmarks = await db.all(sql)
  bookmarks = bookmarks.map(toNewFormat)

  // apply tag filter
  if (filters && filters.tag) {
    if (Array.isArray(filters.tag)) {
      bookmarks = bookmarks.filter(b => {
        return /** @type string[] */(filters.tag).reduce((agg, t) => agg && b.tags.includes(t), true)
      })
    } else {
      bookmarks = bookmarks.filter(b => b.tags.includes(filters.tag))
    }
  }

  return bookmarks
}

/**
 * @param {number} profileId
 * @returns {Promise<Array<string>>}
 */
exports.listBookmarkTags = async function (profileId) {
  var tagSet = new Set()
  var bookmarks = await db.all(`SELECT tags FROM bookmarks WHERE profileId = ?`, [profileId])
  bookmarks.forEach(b => {
    if (b.tags) {
      b.tags.split(' ').forEach(t => tagSet.add(t))
    }
  })
  return Array.from(tagSet)
}

/**
 * @param {string | string[]} v
 * @returns {string}
 */
function tagsToString (v) {
  if (Array.isArray(v)) {
    v = v.join(' ')
  }
  return v
}

/**
 * @param {Object} b
 * @returns {Bookmark | null}
 */
function toNewFormat (b) {
  if (!b) return null
  return {
    createdAt: b.createdAt * 1e3, // convert to ms
    href: b.url,
    title: b.title,
    tags: b.tags ? b.tags.split(' ').filter(Boolean) : [],
    pinned: !!b.pinned,
    pinOrder: b.pinOrder
  }
}

/**
 * @param {string} v
 * @returns {void}
 */
function assertValidHref (v) {
  assert(v && typeof v === 'string', 'href must be a valid URL')
}

/**
 * @param {string} v
 * @returns {void}
 */
function assertValidTitle (v) {
  assert(v && typeof v === 'string', 'title must be a non-empty string')
}

/**
 * @param {string|string[]} v
 * @returns {void}
 */
function assertValidTags (v) {
  if (Array.isArray(v)) {
    assert(v.every(item => typeof item === 'string'), 'tags must be a string or array or strings')
  } else {
    assert(typeof v === 'string', 'tags must be a string or array or strings')
  }
}
