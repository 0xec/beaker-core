const { EventTarget, bindEventStream, fromEventStream } = require('./event-target')
const errors = require('beaker-error-constants')

const loggerManifest = require('../manifests/internal/logger')
const archivesManifest = require('../manifests/internal/archives')
const beakerBrowserManifest = require('../manifests/internal/browser')
const downloadsManifest = require('../manifests/internal/downloads')
const historyManifest = require('../manifests/internal/history')
const sitedataManifest = require('../manifests/internal/sitedata')
const domainNamesManifest = require('../manifests/internal/domain-names')
const watchlistManifest = require('../manifests/internal/watchlist')
const templatesManifest = require('../manifests/internal/templates')
const crawlerManifest = require('../manifests/internal/crawler')
const linkFeedManifest = require('../manifests/internal/link-feed')
const followgraphManifest = require('../manifests/internal/followgraph')

exports.setup = function (rpc) {
  const beaker = {}
  const opts = { timeout: false, errors }

  // internal only
  if (window.location.protocol === 'beaker:') {
    const loggerRPC = rpc.importAPI('logger', loggerManifest, opts)
    const archivesRPC = rpc.importAPI('archives', archivesManifest, opts)
    const beakerBrowserRPC = rpc.importAPI('beaker-browser', beakerBrowserManifest, opts)
    const downloadsRPC = rpc.importAPI('downloads', downloadsManifest, opts)
    const historyRPC = rpc.importAPI('history', historyManifest, opts)
    const sitedataRPC = rpc.importAPI('sitedata', sitedataManifest, opts)
    const domainNamesRPC = rpc.importAPI('domain-names', domainNamesManifest, opts)
    const watchlistRPC = rpc.importAPI('watchlist', watchlistManifest, opts)
    const templatesRPC = rpc.importAPI('templates', templatesManifest, opts)
    const crawlerRPC = rpc.importAPI('crawler', crawlerManifest, opts)
    const linkFeedRPC = rpc.importAPI('link-feed', linkFeedManifest, opts)
    const followgraphRPC = rpc.importAPI('followgraph', followgraphManifest, opts)

    // beaker.logger
    beaker.logger = {}
    beaker.logger.stream = (opts) => fromEventStream(loggerRPC.stream(opts))
    beaker.logger.query = loggerRPC.query

    // beaker.archives
    beaker.archives = new EventTarget()
    beaker.archives.status = archivesRPC.status
    beaker.archives.add = archivesRPC.add
    beaker.archives.publish = archivesRPC.publish
    beaker.archives.unpublish = archivesRPC.unpublish
    beaker.archives.setUserSettings = archivesRPC.setUserSettings
    beaker.archives.remove = archivesRPC.remove
    beaker.archives.bulkRemove = archivesRPC.bulkRemove
    beaker.archives.delete = archivesRPC.delete
    beaker.archives.list = archivesRPC.list
    beaker.archives.validateLocalSyncPath = archivesRPC.validateLocalSyncPath
    beaker.archives.setLocalSyncPath = archivesRPC.setLocalSyncPath
    beaker.archives.ensureLocalSyncFinished = archivesRPC.ensureLocalSyncFinished
    beaker.archives.diffLocalSyncPathListing = archivesRPC.diffLocalSyncPathListing
    beaker.archives.diffLocalSyncPathFile = archivesRPC.diffLocalSyncPathFile
    beaker.archives.publishLocalSyncPathListing = archivesRPC.publishLocalSyncPathListing
    beaker.archives.revertLocalSyncPathListing = archivesRPC.revertLocalSyncPathListing
    beaker.archives.getDraftInfo = archivesRPC.getDraftInfo
    beaker.archives.listDrafts = archivesRPC.listDrafts
    beaker.archives.addDraft = archivesRPC.addDraft
    beaker.archives.removeDraft = archivesRPC.removeDraft
    beaker.archives.touch = archivesRPC.touch
    beaker.archives.clearFileCache = archivesRPC.clearFileCache
    beaker.archives.clearGarbage = archivesRPC.clearGarbage
    beaker.archives.clearDnsCache = archivesRPC.clearDnsCache
    beaker.archives.getDebugLog = archivesRPC.getDebugLog
    beaker.archives.createDebugStream = () => fromEventStream(archivesRPC.createDebugStream())
    window.addEventListener('load', () => {
      try {
        bindEventStream(archivesRPC.createEventStream(), beaker.archives)
      } catch (e) {
        // permissions error
      }
    })

    // beaker.browser
    beaker.browser = {}
    beaker.browser.createEventsStream = () => fromEventStream(beakerBrowserRPC.createEventsStream())
    beaker.browser.getInfo = beakerBrowserRPC.getInfo
    beaker.browser.checkForUpdates = beakerBrowserRPC.checkForUpdates
    beaker.browser.restartBrowser = beakerBrowserRPC.restartBrowser
    beaker.browser.getUserSession = beakerBrowserRPC.getUserSession
    beaker.browser.setUserSession = beakerBrowserRPC.setUserSession
    beaker.browser.showEditProfileModal = beakerBrowserRPC.showEditProfileModal
    beaker.browser.getSetting = beakerBrowserRPC.getSetting
    beaker.browser.getSettings = beakerBrowserRPC.getSettings
    beaker.browser.setSetting = beakerBrowserRPC.setSetting
    beaker.browser.getUserSetupStatus = beakerBrowserRPC.getUserSetupStatus
    beaker.browser.setUserSetupStatus = beakerBrowserRPC.setUserSetupStatus
    beaker.browser.getDefaultLocalPath = beakerBrowserRPC.getDefaultLocalPath
    beaker.browser.setStartPageBackgroundImage = beakerBrowserRPC.setStartPageBackgroundImage
    beaker.browser.getDefaultProtocolSettings = beakerBrowserRPC.getDefaultProtocolSettings
    beaker.browser.setAsDefaultProtocolClient = beakerBrowserRPC.setAsDefaultProtocolClient
    beaker.browser.removeAsDefaultProtocolClient = beakerBrowserRPC.removeAsDefaultProtocolClient
    beaker.browser.fetchBody = beakerBrowserRPC.fetchBody
    beaker.browser.downloadURL = beakerBrowserRPC.downloadURL
    beaker.browser.readFile = beakerBrowserRPC.readFile
    beaker.browser.getResourceContentType = beakerBrowserRPC.getResourceContentType
    beaker.browser.listBuiltinFavicons = beakerBrowserRPC.listBuiltinFavicons
    beaker.browser.getBuiltinFavicon = beakerBrowserRPC.getBuiltinFavicon
    beaker.browser.uploadFavicon = beakerBrowserRPC.uploadFavicon
    beaker.browser.imageToIco = beakerBrowserRPC.imageToIco
    beaker.browser.setWindowDimensions = beakerBrowserRPC.setWindowDimensions
    beaker.browser.showOpenDialog = beakerBrowserRPC.showOpenDialog
    beaker.browser.showContextMenu = beakerBrowserRPC.showContextMenu
    beaker.browser.showShellModal = beakerBrowserRPC.showShellModal
    beaker.browser.openUrl = beakerBrowserRPC.openUrl
    beaker.browser.openFolder = beakerBrowserRPC.openFolder
    beaker.browser.doWebcontentsCmd = beakerBrowserRPC.doWebcontentsCmd
    beaker.browser.doTest = beakerBrowserRPC.doTest
    beaker.browser.closeModal = beakerBrowserRPC.closeModal

    // beaker.downloads
    beaker.downloads = {}
    beaker.downloads.getDownloads = downloadsRPC.getDownloads
    beaker.downloads.pause = downloadsRPC.pause
    beaker.downloads.resume = downloadsRPC.resume
    beaker.downloads.cancel = downloadsRPC.cancel
    beaker.downloads.remove = downloadsRPC.remove
    beaker.downloads.open = downloadsRPC.open
    beaker.downloads.showInFolder = downloadsRPC.showInFolder
    beaker.downloads.createEventsStream = () => fromEventStream(downloadsRPC.createEventsStream())

    // beaker.history
    beaker.history = {}
    beaker.history.addVisit = historyRPC.addVisit
    beaker.history.getVisitHistory = historyRPC.getVisitHistory
    beaker.history.getMostVisited = historyRPC.getMostVisited
    beaker.history.search = historyRPC.search
    beaker.history.removeVisit = historyRPC.removeVisit
    beaker.history.removeAllVisits = historyRPC.removeAllVisits
    beaker.history.removeVisitsAfter = historyRPC.removeVisitsAfter

    // beaker.sitedata
    beaker.sitedata = {}
    beaker.sitedata.get = sitedataRPC.get
    beaker.sitedata.set = sitedataRPC.set
    beaker.sitedata.getPermissions = sitedataRPC.getPermissions
    beaker.sitedata.getAppPermissions = sitedataRPC.getAppPermissions
    beaker.sitedata.getPermission = sitedataRPC.getPermission
    beaker.sitedata.setPermission = sitedataRPC.setPermission
    beaker.sitedata.setAppPermissions = sitedataRPC.setAppPermissions
    beaker.sitedata.clearPermission = sitedataRPC.clearPermission
    beaker.sitedata.clearPermissionAllOrigins = sitedataRPC.clearPermissionAllOrigins

    // beaker.domainNames
    beaker.domainNames = {
      set: domainNamesRPC.set,
      delete: domainNamesRPC.delete,
      get: domainNamesRPC.get,
      list: domainNamesRPC.list
    }

    // beaker.watchlist
    beaker.watchlist = {}
    beaker.watchlist.add = watchlistRPC.add
    beaker.watchlist.list = watchlistRPC.list
    beaker.watchlist.update = watchlistRPC.update
    beaker.watchlist.remove = watchlistRPC.remove
    beaker.watchlist.createEventsStream = () => fromEventStream(watchlistRPC.createEventsStream())

    // beaker.templates
    beaker.templates = {}
    beaker.templates.get = templatesRPC.get
    beaker.templates.list = templatesRPC.list
    beaker.templates.put = templatesRPC.put
    beaker.templates.remove = templatesRPC.remove

    // beaker.crawler
    beaker.crawler = {}
    beaker.crawler.listSuggestions = crawlerRPC.listSuggestions
    beaker.crawler.listSearchResults = crawlerRPC.listSearchResults
    beaker.crawler.getCrawlStates = crawlerRPC.getCrawlStates
    beaker.crawler.crawlSite = crawlerRPC.crawlSite
    beaker.crawler.resetSite = crawlerRPC.resetSite
    beaker.crawler.createEventsStream = () => fromEventStream(crawlerRPC.createEventsStream())

    // beaker.linkFeed
    beaker.linkFeed = {}
    beaker.linkFeed.list = linkFeedRPC.list
    beaker.linkFeed.get = linkFeedRPC.get
    beaker.linkFeed.create = linkFeedRPC.create
    beaker.linkFeed.edit = linkFeedRPC.edit
    beaker.linkFeed.delete = linkFeedRPC.delete

    // beaker.followgraph
    beaker.followgraph = {}
    beaker.followgraph.listFollowers = followgraphRPC.listFollowers
    beaker.followgraph.listFollows = followgraphRPC.listFollows
    beaker.followgraph.listFoaFs = followgraphRPC.listFoaFs
    beaker.followgraph.isAFollowingB = followgraphRPC.isAFollowingB
    beaker.followgraph.follow = followgraphRPC.follow
    beaker.followgraph.unfollow = followgraphRPC.unfollow
  }

  return beaker
}
