const emitStream = require('emit-stream')
const EventEmitter = require('events')
const datEncoding = require('dat-encoding')
const pify = require('pify')
const pda = require('pauls-dat-api')
const signatures = require('sodium-signatures')
const parseDatURL = require('parse-dat-url')
const debounce = require('lodash.debounce')
const mkdirp = require('mkdirp')

// dbs
const siteData = require('../dbs/sitedata')
const settingsDb = require('../dbs/settings')
const archivesDb = require('../dbs/archives')

// dat modules
const datGC = require('./garbage-collector')


// constants
// =

const {
  DAT_HASH_REGEX,
  DAT_PRESERVED_FIELDS_ON_FORK
} = require('../lib/const')
const {InvalidURLError} = require('beaker-error-constants')
const DAT_DAEMON_MANIFEST = require('./daemon/manifest')

// globals
// =

var archives = {} // in-memory cache of archive objects. key -> archive
var archiveLoadPromises = {} // key -> promise
var archivesEvents = new EventEmitter()
var daemonEvents
var daemon

// exported API
// =

exports.setup = async function setup ({rpcAPI, datDaemonWc, disallowedSavePaths}) {
  // connect to the daemon
  daemon = createDaemonRPC(rpcAPI, datDaemonWc)
  daemon.setup({disallowedSavePaths, datPath: archivesDb.getDatPath()})
  daemonEvents = emitStream(daemon.createEventStream())

  // wire up event handlers
  archivesDb.on('update:archive-user-settings', async (key, userSettings, newUserSettings) => {
    // emit event
    var details = {
      url: 'dat://' + key,
      isSaved: userSettings.isSaved,
      hidden: userSettings.hidden,
      networked: userSettings.networked,
      autoDownload: userSettings.autoDownload,
      autoUpload: userSettings.autoUpload,
      localSyncPath: userSettings.localSyncPath,
      previewMode: userSettings.previewMode
    }
    archivesEvents.emit('updated', {details})
    if ('isSaved' in newUserSettings) {
      archivesEvents.emit(newUserSettings.isSaved ? 'added' : 'removed', {details})
    }

    // delete all perms for deleted archives
    if (!userSettings.isSaved) {
      siteData.clearPermissionAllOrigins('modifyDat:' + key)
    }

    // update the download based on these settings
    daemon.configureArchive(key, userSettings)
  })

  // re-export events
  daemonEvents.on('network-changed', evt => archivesEvents.emit('network-changed', evt))
  daemonEvents.on('folder-synced', evt => archivesEvents.emit('folder-synced', evt))
  daemonEvents.on('folder-sync-error', evt => archivesEvents.emit('folder-sync-error', evt))

  // configure the bandwidth throttle
  settingsDb.getAll().then(({dat_bandwidth_limit_up, dat_bandwidth_limit_down}) => {
    daemon.setBandwidthThrottle({
      up: dat_bandwidth_limit_up,
      down: dat_bandwidth_limit_down
    })
  })
  settingsDb.on('set:dat_bandwidth_limit_up', up => daemon.setBandwidthThrottle({up}))
  settingsDb.on('set:dat_bandwidth_limit_down', down => daemon.setBandwidthThrottle({down}))

  // start the GC manager
  datGC.setup()
}

exports.getDaemon = () => daemon

exports.loadSavedArchives = function () {
  // load and configure all saved archives
  return archivesDb.query(0, {isSaved: true}).then(
    async (archives) => {
      // HACK
      // load the archives one at a time and give 5 seconds between each
      // why: the purpose of loading saved archives is to seed them
      // loading them all at once can bog down the user's device
      // if the user tries to access an archive, Beaker will load it immediately
      // so spacing out the loads has no visible impact on the user
      // (except for reducing the overall load for the user)
      // -prf
      for (let a of archives) {
        loadArchive(a.key, a.userSettings)
        await new Promise(r => setTimeout(r, 5e3)) // wait 5s
      }
    },
    err => console.error('Failed to load networked archives', err)
  )
}

exports.createEventStream = function createEventStream () {
  return emitStream(archivesEvents)
}

exports.getDebugLog = function getDebugLog (key) {
  return daemon.getDebugLog(key)
}

exports.createDebugStream = function createDebugStream () {
  return daemon.createDebugStream()
}

// read metadata for the archive, and store it in the meta db
const pullLatestArchiveMeta = exports.pullLatestArchiveMeta = async function pullLatestArchiveMeta (archive, {updateMTime} = {}) {
  try {
    var key = archive.key.toString('hex')

    // ready() just in case (we need .blocks)
    await pify(archive.ready.bind(archive))()

    // read the archive meta and size on disk
    var [manifest, oldMeta, size] = await Promise.all([
      pda.readManifest(archive).catch(_ => {}),
      archivesDb.getMeta(key),
      daemon.updateSizeTracking(key)
    ])
    var {title, description, type} = (manifest || {})
    var isOwner = archive.writable
    var mtime = updateMTime ? Date.now() : oldMeta.mtime

    // write the record
    var details = {title, description, type, mtime, size, isOwner}
    await archivesDb.setMeta(key, details)

    // emit the updated event
    details.url = 'dat://' + key
    archivesEvents.emit('updated', {details})
    return details
  } catch (e) {
    console.error('Error pulling meta', e)
  }
}

// archive creation
// =

const createNewArchive = exports.createNewArchive = async function createNewArchive (manifest = {}, settings = false) {
  var userSettings = {
    isSaved: !(settings && settings.isSaved === false),
    networked: !(settings && settings.networked === false),
    hidden: settings && settings.hidden === true,
    previewMode: settings && settings.previewMode === true,
    localSyncPath: settings && settings.localSyncPath
  }

  // create the archive
  var archive = await loadArchive(null, userSettings)
  var key = datEncoding.toStr(archive.key)

  // write the manifest and default datignore
  await Promise.all([
    pda.writeManifest(archive, manifest),
    pda.writeFile(archive, '/.datignore', await settingsDb.get('default_dat_ignore'), 'utf8')
  ])

  // write the user settings
  await archivesDb.setUserSettings(0, key, userSettings)

  // write the metadata
  await pullLatestArchiveMeta(archive)

  return `dat://${key}/`
}

exports.forkArchive = async function forkArchive (srcArchiveUrl, manifest = {}, settings = false) {
  srcArchiveUrl = fromKeyToURL(srcArchiveUrl)

  // get the old archive
  var srcArchive = getArchive(srcArchiveUrl)
  if (!srcArchive) {
    throw new Error('Invalid archive key')
  }

  // fetch old archive meta
  var srcManifest = await pda.readManifest(srcArchive).catch(_ => {})
  srcManifest = srcManifest || {}

  // override any manifest data
  var dstManifest = {
    title: (manifest.title) ? manifest.title : srcManifest.title,
    description: (manifest.description) ? manifest.description : srcManifest.description,
    type: (manifest.type) ? manifest.type : srcManifest.type,
    author: manifest.author
  }
  DAT_PRESERVED_FIELDS_ON_FORK.forEach(field => {
    if (srcManifest[field]) {
      dstManifest[field] = srcManifest[field]
    }
  })

  // create the new archive
  var dstArchiveUrl = await createNewArchive(dstManifest, settings)
  var dstArchive = getArchive(dstArchiveUrl)

  // copy files
  var ignore = ['/.dat', '/.git', '/dat.json']
  await pda.exportArchiveToArchive({
    srcArchive,
    dstArchive,
    skipUndownloadedFiles: true,
    ignore
  })

  // write a .datignore if DNE
  try {
    await pda.stat(dstArchive, '/.datignore')
  } catch (e) {
    await pda.writeFile(dstArchive, '/.datignore', await settingsDb.get('default_dat_ignore'), 'utf8')
  }

  return dstArchiveUrl
}

// archive management
// =

const loadArchive = exports.loadArchive = async function loadArchive (key, userSettings = null) {
  // validate key
  var secretKey
  if (key) {
    if (!Buffer.isBuffer(key)) {
      // existing dat
      key = fromURLToKey(key)
      if (!DAT_HASH_REGEX.test(key)) {
        throw new InvalidURLError()
      }
      key = datEncoding.toBuf(key)
    }
  } else {
    // new dat, generate keys
    var kp = signatures.keyPair()
    key = kp.publicKey
    secretKey = kp.secretKey
  }

  // fallback to the promise, if possible
  var keyStr = datEncoding.toStr(key)
  if (keyStr in archiveLoadPromises) {
    return archiveLoadPromises[keyStr]
  }

  // run and cache the promise
  var p = loadArchiveInner(key, secretKey, userSettings)
  archiveLoadPromises[keyStr] = p
  p.catch(err => {
    console.error('Failed to load archive', err)
  })

  // when done, clear the promise
  const clear = () => delete archiveLoadPromises[keyStr]
  p.then(clear, clear)

  return p
}

// main logic, separated out so we can capture the promise
async function loadArchiveInner (key, secretKey, userSettings = null) {
  // load the user settings as needed
  if (!userSettings) {
    try {
      userSettings = await archivesDb.getUserSettings(0, key)
    } catch (e) {
      userSettings = {networked: true}
    }
  }
  if (!('networked' in userSettings)) {
    userSettings.networked = true
  }

  // ensure the folders exist
  var metaPath = archivesDb.getArchiveMetaPath(key)
  mkdirp.sync(metaPath)

  // load the archive in the daemon
  var archiveInfo = await daemon.loadArchive({
    key,
    secretKey,
    metaPath,
    userSettings
  })

  // create the archive proxy instance
  var archive = createArchiveProxy(key, undefined, archiveInfo)

  // update db
  archivesDb.touch(key).catch(err => console.error('Failed to update lastAccessTime for archive', key, err))
  await pullLatestArchiveMeta(archive)

  // wire up events
  archive.pullLatestArchiveMeta = debounce(opts => pullLatestArchiveMeta(archive, opts), 1e3)
  archive.fileActStream = daemon.callWatch(archive)
  archive.fileActStream.on('data', ([event, {path}]) => {
    if (event === 'changed') {
      archive.pullLatestArchiveMeta({updateMTime: true})
      let syncSettings = archive.localSyncSettings
      if (syncSettings) {
        // need to sync this change to the local folder
        if (syncSettings.autoPublish) {
          // bidirectional sync: use the sync queue
          folderSync.queueSyncEvent(archive, {toFolder: true})
        } else {
          // preview mode: just write this update to disk
          folderSync.syncArchiveToFolder(archive, {paths: [path], shallow: false})
        }
      }
    }
  })

  // now store in main archives listing, as loaded
  archives[datEncoding.toStr(archive.key)] = archive
  return archive
}

const getArchive = exports.getArchive = function getArchive (key) {
  key = fromURLToKey(key)
  return archives[key]
}

exports.getArchiveCheckout = function getArchiveCheckout (archive, version) {
  var isHistoric = false
  var isPreview = false
  var checkoutFS = archive
  if (version) {
    let seq = parseInt(version)
    if (Number.isNaN(seq)) {
      if (version === 'latest') {
        // ignore, we use latest by default
      } else if (version === 'preview') {
        isPreview = true
        checkoutFS = createArchiveProxy(archive.key, 'preview', archive)
      } else {
        throw new Error('Invalid version identifier:' + version)
      }
    } else {
      checkoutFS = createArchiveProxy(archive.key, version, archive)
      isHistoric = true
    }
  }
  return {isHistoric, isPreview, checkoutFS}
}

exports.getActiveArchives = function getActiveArchives () {
  return archives
}

const getOrLoadArchive = exports.getOrLoadArchive = async function getOrLoadArchive (key, opts) {
  var archive = getArchive(key)
  if (archive) {
    return archive
  }
  return loadArchive(key, opts)
}

exports.unloadArchive = async function unloadArchive (key) {
  key = fromURLToKey(key)
  if (!archives[key]) return
  delete archives[key]
  await daemon.unloadArchive(key)
}

const isArchiveLoaded = exports.isArchiveLoaded = function isArchiveLoaded (key) {
  key = fromURLToKey(key)
  return key in archives
}

exports.updateSizeTracking = function updateSizeTracking (archive) {
  return daemon.updateSizeTracking(datEncoding.toStr(archive.key))
}

// archive fetch/query
// =

exports.queryArchives = async function queryArchives (query) {
  // run the query
  var archiveInfos = await archivesDb.query(0, query)

  if (query && ('inMemory' in query)) {
    archiveInfos = archiveInfos.filter(archiveInfo => isArchiveLoaded(archiveInfo.key) === query.inMemory)
  }

  // attach some live data
  await Promise.all(archiveInfos.map(async (archiveInfo) => {
    var archive = getArchive(archiveInfo.key)
    if (archive) {
      var info = await daemon.getArchiveInfo(archiveInfo.key)
      archiveInfo.isSwarmed = archiveInfo.userSettings.networked
      archiveInfo.size = info.size
      archiveInfo.peers = info.peers
      archiveInfo.peerHistory = info.peerHistory
    } else {
      archiveInfo.isSwarmed = false
      archiveInfo.peers = 0
      archiveInfo.peerHistory = []
    }
  }))
  return archiveInfos
}

exports.getArchiveInfo = async function getArchiveInfo (key) {
  // get the archive
  key = fromURLToKey(key)
  var archive = await getOrLoadArchive(key)

  // fetch archive data
  var [meta, userSettings, manifest, archiveInfo] = await Promise.all([
    archivesDb.getMeta(key),
    archivesDb.getUserSettings(0, key),
    pda.readManifest(archive).catch(_ => {}),
    daemon.getArchiveInfo(key)
  ])
  manifest = manifest || {}
  meta.key = key
  meta.url = `dat://${key}`
  meta.links = manifest.links || {}
  meta.manifest = manifest
  meta.version = archiveInfo.version
  meta.size = archiveInfo.size
  meta.userSettings = {
    isSaved: userSettings.isSaved,
    hidden: userSettings.hidden,
    networked: userSettings.networked,
    autoDownload: userSettings.autoDownload,
    autoUpload: userSettings.autoUpload,
    expiresAt: userSettings.expiresAt,
    localSyncPath: userSettings.localSyncPath,
    previewMode: userSettings.previewMode
  }
  meta.peers = archiveInfo.peers
  meta.peerInfo = archiveInfo.peerInfo
  meta.peerHistory = archiveInfo.peerHistory
  meta.networkStats = archiveInfo.networkStats

  return meta
}

exports.clearFileCache = async function clearFileCache (key) {
  var userSettings = await archivesDb.getUserSettings(0, key)
  return daemon.clearFileCache(key, userSettings)
}

// helpers
// =

function createDaemonRPC (rpcAPI, datDaemonWc) {
  var api = rpcAPI.importAPI('dat-daemon', DAT_DAEMON_MANIFEST, {wc: datDaemonWc})
  // wrap some functions
  var callWatch = api.callWatch.bind(api)
  api.callWatch = (archive, ...args) => {
    var key = datEncoding.toStr(archive.key ? archive.key : archive)
    return emitStream(callWatch(key, ...args))
  }
  return api
}

const fromURLToKey = exports.fromURLToKey = function fromURLToKey (url) {
  if (Buffer.isBuffer(url)) {
    return url
  }
  if (DAT_HASH_REGEX.test(url)) {
    // simple case: given the key
    return url
  }

  var urlp = parseDatURL(url)

  // validate
  if (urlp.protocol !== 'dat:') {
    throw new InvalidURLError('URL must be a dat: scheme')
  }
  if (!DAT_HASH_REGEX.test(urlp.host)) {
    // TODO- support dns lookup?
    throw new InvalidURLError('Hostname is not a valid hash')
  }

  return urlp.host
}

const fromKeyToURL = exports.fromKeyToURL = function fromKeyToURL (key) {
  if (typeof key !== 'string') {
    key = datEncoding.toStr(key)
  }
  if (!key.startsWith('dat://')) {
    return `dat://${key}/`
  }
  return key
}

// archive proxy
// =

function makeArchiveProxyCbFn (key, version, method) {
  return (...args) => daemon.callArchiveAsyncMethod(key, version, method, ...args)
}

function makeArchiveProxyReadStreamFn (key, version, method) {
  return (...args) => daemon.callArchiveReadStreamMethod(key, version, method, ...args)
}

function makeArchiveProxyWriteStreamFn (key, version, method) {
  return (...args) => daemon.callArchiveWriteStreamMethod(key, version, method, ...args)
}

function createArchiveProxy (key, version, archiveInfo) {
  key = datEncoding.toStr(key)
  const stat = makeArchiveProxyCbFn(key, version, 'stat')
  return {
    key: datEncoding.toBuf(key),
    discoveryKey: datEncoding.toBuf(archiveInfo.discoveryKey),
    writable: archiveInfo.writable,

    ready: makeArchiveProxyCbFn(key, version, 'ready'),
    download: makeArchiveProxyCbFn(key, version, 'download'),
    history: makeArchiveProxyReadStreamFn(key, version, 'history'),
    createReadStream: makeArchiveProxyReadStreamFn(key, version, 'createReadStream'),
    readFile: makeArchiveProxyCbFn(key, version, 'readFile'),
    createDiffStream: makeArchiveProxyReadStreamFn(key, version, 'createDiffStream'),
    createWriteStream: makeArchiveProxyWriteStreamFn(key, version, 'createWriteStream'),
    writeFile: makeArchiveProxyCbFn(key, version, 'writeFile'),
    unlink: makeArchiveProxyCbFn(key, version, 'unlink'),
    mkdir: makeArchiveProxyCbFn(key, version, 'mkdir'),
    rmdir: makeArchiveProxyCbFn(key, version, 'rmdir'),
    readdir: makeArchiveProxyCbFn(key, version, 'readdir'),
    stat: (...args) => {
      var cb = args.pop()
      args.push((err, st) => {
        if (st) {
          // turn into proper stat object
          st.atime = new Date(st.atime)
          st.mtime = new Date(st.mtime)
          st.ctime = new Date(st.ctime)
          st.isSocket = () => false
          st.isSymbolicLink = () => false
          st.isFile = () => st.mode & 32768 === 32768
          st.isBlockDevice = () => false
          st.isDirectory = () => st.mode & 16384 === 16384
          st.isCharacterDevice = () => false
          st.isFIFO = () => false
        }
        cb(err, st)
      })
      stat(...args)
    },
    lstat: makeArchiveProxyCbFn(key, version, 'lstat'),
    access: makeArchiveProxyCbFn(key, version, 'access')
  }
}

