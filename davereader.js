/*  The MIT License (MIT)
	Copyright (c) 2014-2016 Dave Winer

	Permission is hereby granted, free of charge, to any person obtaining a copy
	of this software and associated documentation files (the "Software"), to deal
	in the Software without restriction, including without limitation the rights
	to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
	copies of the Software, and to permit persons to whom the Software is
	furnished to do so, subject to the following conditions:

	The above copyright notice and this permission notice shall be included in all
	copies or substantial portions of the Software.

	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
	IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
	FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
	AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
	LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
	OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
	SOFTWARE.
	*/

const packageData = require('./package.json');

const myProductName = packageData.name;
const myVersion = packageData.version;


exports.init = init;
exports.httpRequest = handleHttpRequest; // 3/24/17 by DW
exports.readAllFeedsNow = readAllFeedsNow; // 4/18/17 by DW
exports.notifyWebSocketListeners = notifyWebSocketListeners; // 6/20/17 by DW

const fs = require('fs');
const request = require('request');
const http = require('http');
const urlpack = require('url');
const md5 = require('md5');
const websocket = require('nodejs-websocket');
const qs = require('querystring');
const OpmlParser = require('opmlparser');
const FeedParser = require('feedparser');
const utils = require('daveutils');

const config = {
	enabled: true,

	httpPort: 1337,
	flHttpEnabled: true,
	webSocketPort: 1338,
	flWebSocketEnabled: true,

	dataFolder: 'data/',
	listsFolder: 'lists/',
	riversFolder: 'rivers/',
	podcastsFolder: 'podcasts/', // 4/17/17 by DW

	localStoragePath: 'localStorage.json',
	statsFilePath: 'serverStats.json',
	templatePath: 'misc/template.html',
	addToRiverCallbacksFolder: 'callbacks/addToRiver/',
	buildRiverCallbacksFolder: 'callbacks/buildRiver/', // 4/23/17 by DW

	riverDataFileName: 'riverData.json',
	listInfoFileName: 'listInfo.json',

	flAddItemsFromNewSubs: true,
	maxRiverItems: 250,
	maxBodyLength: 280,
	flSkipDuplicateTitles: true,
	flRequestCloudNotify: true,
	flMaintainCalendarStructure: false,
	flWriteItemsToFiles: false,
	ctMinutesBetwBuilds: 15,
	maxConcurrentFileWrites: 100,
	remotePassword: '',

	flWatchAppDateChange: false,
	fnameApp: 'lib/feedtools.js',

	urlServerHomePageSource: 'http://rss2.io/code/feedtools/misc/serverhomepage.html',
	urlDashboardSource: 'http://rss2.io/code/feedtools/misc/dashboard.html',
	urlFeedViewerApp: 'http://rss2.io/code/feedtools/feedviewer/', // 7/10/17 by DW
	urlFavicon: 'http://rss2.io/code/favicon.ico',

	notifyListenersCallback: undefined, // 3/25/17 by DW
	statsChangedCallback: undefined, // 3/25/17 by DW
	consoleLogCallback: undefined, // 3/28/17 by DW
	newItemCallback: undefined, // 5/17/17 by DW
	handleHttpRequestCallback: undefined, // 6/20/17 by DW
	everyMinuteCallback: undefined, // 6/20/17 by DW
	everySecondCallback: undefined, // 6/20/17 by DW

	flBuildEveryFiveSeconds: false, // 3/29/17 by DW

	flDownloadPodcasts: false, // 6/7/17 by DW -- changed to false
	maxFileNameLength: 32, // 4/17/17 by DW
	maxConcurrentPodcastDownloads: 10, // 4/17/17 by DW

	flSaveFeedRivers: true, // 6/29/17 by DW
};
const serverStats = {
	aggregator: `${myProductName} v${myVersion}`,

	ctStarts: 0,
	ctFeedReads: 0,
	ctFeedReadsThisRun: 0,
	ctFeedReadsToday: 0,
	ctFeedReadsLastHour: 0,
	ctRiverSaves: 0,
	ctStoriesAdded: 0,
	ctStoriesAddedThisRun: 0,
	ctStoriesAddedToday: 0,
	ctHits: 0,
	ctHitsToday: 0,
	ctHitsThisRun: 0,
	ctListFolderReads: 0,
	ctRssCloudUpdates: 0,
	ctLocalStorageWrites: 0,
	ctStatsSaves: 0,
	ctFeedStatsSaves: 0,
	ctRiverJsonSaves: 0,
	ctRssCloudRenews: 0,

	ctSecsSinceLastStart: 0,
	ctSecsSinceLastFeedReed: 0,

	whenFirstStart: new Date(),
	whenLastStart: new Date(0),
	whenLastFeedRead: new Date(0),
	whenLastRiverSave: new Date(0),
	whenLastStoryAdded: new Date(0),
	whenLastListFolderRead: new Date(0),
	whenLastRssCloudUpdate: new Date(0),
	whenLastLocalStorageWrite: new Date(0),
	whenLastStatsSave: new Date(0),
	whenLastFeedStatsSave: new Date(0),
	whenLastRiverJsonSave: new Date(0),
	whenLastRssCloudRenew: new Date(0),

	lastFeedRead: '',
	serialnum: 0, // each new story gets an ID
	urlFeedLastCloudUpdate: '', // the last feed we got pinged about
	listNames: new Array(),
	listsThatChanged: new Array(),

	lastStoryAdded: new Object(),
};
let flStatsChanged = false;
let flEveryMinuteScheduled = false;
let lastEveryMinuteHour = -1;
const whenServerStart = new Date();
let origAppModDate = new Date(0);

function getRequestOptions(urlToRequest) {
	const options = {
		url: urlToRequest,
		jar: true,
		gzip: true, // 6/25/17 by DW
		maxRedirects: 5,
		headers: {
			'User-Agent': `${myProductName} v${myVersion}`,
		},
	};
	return (options);
}
function myRequestCall(url) { // 2/11/17 by DW
	return (request(getRequestOptions(url)));
}
function myConsoleLog(s) { // 3/28/17 by DW
	if (config.consoleLogCallback !== undefined) {
		config.consoleLogCallback(s);
	}
	console.log(s);
}

// files
function readFile(relpath, callback) {
	const f = config.dataFolder + relpath;
	fsSureFilePath(f, () => {
		fs.exists(f, (flExists) => {
			if (flExists) {
				fs.readFile(f, (err, data) => {
					if (err) {
						console.log(`readFile: error reading file ${f} == ${err.message}`);
						callback(undefined);
					} else {
						callback(data);
					}
				});
			} else {
				callback(undefined);
			}
		});
	});
}
function writeFile(relpath, data, callback) {
	const f = config.dataFolder + relpath;
	fsSureFilePath(f, () => {
		fs.writeFile(f, data, (err) => {
			if (err) {
				myConsoleLog(`writeFile: relpath == ${relpath}, error == ${err.message}`);
			}
			if (callback !== undefined) {
				callback();
			}
		});
	});
}
function readStats(relpath, stats, callback) {
	readFile(relpath, (data) => {
		if (data !== undefined) {
			try {
				const savedStats = JSON.parse(data.toString());
				for (const x in savedStats) {
					stats[x] = savedStats[x];
				}
			} catch (err) {
				writeStats(relpath, stats); // write initial values
			}
		} else {
			writeStats(relpath, stats); // write initial values
		}
		if (callback !== undefined) {
			callback();
		}
	});
}
function writeStats(relpath, stats, callback) {
	writeFile(relpath, utils.jsonStringify(stats), () => {
		if (callback !== undefined) {
			callback();
		}
	});
}
function listFiles(folder, callback) {
	fsSureFilePath(`${folder}xxx`, () => {
		fs.readdir(folder, (err, list) => {
			if (!endsWithChar(folder, '/')) {
				folder += '/';
			}
			if (list !== undefined) { // 6/4/15 by DW
				for (let i = 0; i < list.length; i++) {
					callback(folder + list[i]);
				}
			}
			callback(undefined);
		});
	});
}

// file write queue
let fileWriteQueue = new Array(),
	flFileWriteQueueChanged = false;
function pushFileWriteQueue(theFile, theData) {
	fileWriteQueue[fileWriteQueue.length] = {
		f: theFile,
		jsontext: utils.jsonStringify(theData),
	};
	flFileWriteQueueChanged = true;
}
function checkFileWriteQueue() {
	let ct = 0;
	while (fileWriteQueue.length > 0) {
		const item = fileWriteQueue[0];
		fileWriteQueue.shift(); // remove first element
		writeFile(item.f, item.jsontext);
		if (++ct > config.maxConcurrentFileWrites) {
			break;
		}
	}
}
// feeds array
let feedsArray = [],
	flFeedsArrayChanged = false,
	fnameFeedsStats = 'feedsStats.json';

function initFeedsArrayItem(feedstats) {
	if (feedstats.description === undefined) { // 5/28/14 by DW
		feedstats.description = '';
	}

	if (feedstats.ctReads === undefined) {
		feedstats.ctReads = 0;
	}
	if (feedstats.whenLastRead === undefined) {
		feedstats.whenLastRead = new Date(0);
	}

	if (feedstats.ctItems === undefined) {
		feedstats.ctItems = 0;
	}
	if (feedstats.whenLastNewItem === undefined) {
		feedstats.whenLastNewItem = new Date(0);
	}

	if (feedstats.ctReadErrors === undefined) {
		feedstats.ctReadErrors = 0;
	}
	if (feedstats.whenLastReadError === undefined) {
		feedstats.whenLastReadError = new Date(0);
	}
	if (feedstats.ctConsecutiveReadErrors === undefined) {
		feedstats.ctConsecutiveReadErrors = 0;
	}

	if (feedstats.ctTimesChosen === undefined) {
		feedstats.ctTimesChosen = 0;
	}
	if (feedstats.whenLastChosenToRead === undefined) {
		feedstats.whenLastChosenToRead = new Date(0);
	}

	if (feedstats.ctCloudRenew === undefined) {
		feedstats.ctCloudRenew = 0;
	}
	if (feedstats.ctCloudRenewErrors === undefined) {
		feedstats.ctCloudRenewErrors = 0;
	}
	if (feedstats.ctConsecutiveCloudRenewErrors === undefined) {
		feedstats.ctConsecutiveCloudRenewErrors = 0;
	}
	if (feedstats.whenLastCloudRenew === undefined) {
		feedstats.whenLastCloudRenew = new Date(0);
	}
	if (feedstats.whenLastCloudRenewError === undefined) {
		feedstats.whenLastCloudRenewError = new Date(0);
	}
}
function findInFeedsArray(urlfeed) {
	let lowerfeed = urlfeed.toLowerCase(),
		flfound = false,
		ixfeed;
	for (let i = 0; i < feedsArray.length; i++) {
		if (feedsArray[i].url.toLowerCase() == lowerfeed) {
			const feedstats = feedsArray[i];
			initFeedsArrayItem(feedstats);
			return (feedstats);
		}
	}
	return (undefined);
}
function addFeedToFeedsArray(urlfeed, listname) {
	const obj = {
		url: urlfeed,
		lists: [],
	};
	if (listname !== undefined) {
		obj.lists[obj.lists.length] = listname;
	}
	initFeedsArrayItem(obj);
	feedsArray[feedsArray.length] = obj;
	flFeedsArrayChanged = true;
	return (obj);
}
function saveFeedsArray() {
	serverStats.ctFeedStatsSaves++;
	serverStats.whenLastFeedStatsSave = new Date();
	flStatsChanged = true;
	writeStats(fnameFeedsStats, feedsArray);
}
function getFeedTitle(urlfeed) {
	const feedStats = findInFeedsArray(urlfeed);
	return (feedStats.title);
}

// feeds in lists object
let feedsInLists = new Object(),
	flFeedsInListsChanged = false,
	fnameFeedsInLists = 'feedsInLists.json';

function atLeastOneSubscriber(urlfeed) {
	const ctsubscribers = feedsInLists[urlfeed];
	if (ctsubscribers === undefined) {
		return (false);
	}
	return (Number(ctsubscribers) > 0);
}
function addToFeedsInLists(urlfeed) { // 5/30/14 by DW
	if (feedsInLists[urlfeed] === undefined) {
		feedsInLists[urlfeed] = 1;
	} else {
		feedsInLists[urlfeed]++;
	}
	flFeedsInListsChanged = true;
}
function saveFeedsInLists() {
	writeStats(fnameFeedsInLists, feedsInLists);
}
// feeds
function getFolderForFeed(urlfeed) { // return path to the folder for the feed
	let s = urlfeed;
	if (utils.beginsWith(s, 'http://')) {
		s = utils.stringDelete(s, 1, 7);
	} else if (utils.beginsWith(s, 'https://')) {
		s = utils.stringDelete(s, 1, 8);
	}
	s = cleanFilenameForPlatform(s);
	s = `feeds/${s}/`;
	return (s);
}
function writeFeedInfoFile(feed, callback) {
	const f = `${getFolderForFeed(feed.prefs.url)}feedInfo.json`;

	feed.stats.ctInfoWrites++;
	feed.stats.whenLastInfoWrite = new Date();

	writeFile(f, utils.jsonStringify(feed), () => {
		if (callback !== undefined) {
			callback();
		}
	});
}
function initFeed(urlfeed, callback) {
	const f = `${getFolderForFeed(urlfeed)}feedInfo.json`;
	function initFeedStruct(obj) {
		// prefs
		if (obj.prefs === undefined) {
			obj.prefs = new Object();
		}
		if (obj.prefs.enabled === undefined) {
			obj.prefs.enabled = true;
		}
		if (obj.prefs.url === undefined) {
			obj.prefs.url = urlfeed;
		}
		if (obj.prefs.ctSecsBetwRenews === undefined) {
			obj.prefs.ctSecsBetwRenews = 24 * 60 * 60; // 24 hours
		}
		if (obj.prefs.flNonListSubscribe === undefined) {
			obj.prefs.flNonListSubscribe = false;
		}
		// data
		if (obj.data === undefined) {
			obj.data = new Object();
		}
		if (obj.data.feedhash === undefined) {
			obj.data.feedhash = '';
		}
		// stats
		if (obj.stats === undefined) {
			obj.stats = new Object();
		}
		if (obj.stats.ctReads === undefined) {
			obj.stats.ctReads = 0;
		}
		if (obj.stats.ctReadErrors === undefined) {
			obj.stats.ctReadErrors = 0;
		}
		if (obj.stats.ctConsecutiveReadErrors === undefined) {
			obj.stats.ctConsecutiveReadErrors = 0;
		}
		if (obj.stats.ctItems === undefined) {
			obj.stats.ctItems = 0;
		}
		if (obj.stats.ctEnclosures === undefined) {
			obj.stats.ctEnclosures = 0;
		}
		if (obj.stats.ctFeedTextChanges === undefined) {
			obj.stats.ctFeedTextChanges = 0;
		}
		if (obj.stats.ct304s === undefined) {
			obj.stats.ct304s = 0;
		}
		if (obj.stats.ctItemsTooOld === undefined) {
			obj.stats.ctItemsTooOld = 0;
		}
		if (obj.stats.ctReadsSkipped === undefined) {
			obj.stats.ctReadsSkipped = 0;
		}
		if (obj.stats.ctInfoReads === undefined) {
			obj.stats.ctInfoReads = 0;
		}
		if (obj.stats.ctInfoWrites === undefined) {
			obj.stats.ctInfoWrites = 0;
		}
		if (obj.stats.whenSubscribed === undefined) {
			obj.stats.whenSubscribed = new Date();
		}
		if (obj.stats.whenLastRead === undefined) {
			obj.stats.whenLastRead = new Date(0);
		}
		if (obj.stats.whenLastNewItem === undefined) {
			obj.stats.whenLastNewItem = new Date(0);
		}
		if (obj.stats.mostRecentPubDate === undefined) {
			obj.stats.mostRecentPubDate = new Date(0);
		}
		if (obj.stats.whenLastInfoWrite === undefined) {
			obj.stats.whenLastInfoWrite = new Date(0);
		}
		if (obj.stats.whenLastReadError === undefined) {
			obj.stats.whenLastReadError = new Date(0);
		}
		if (obj.stats.whenLastInfoRead === undefined) {
			obj.stats.whenLastInfoRead = new Date(0);
		}
		if (obj.stats.lastReadError === undefined) {
			obj.stats.lastReadError = '';
		}
		if (obj.stats.itemSerialnum === undefined) {
			obj.stats.itemSerialnum = 0;
		}

		// feedInfo
		if (obj.feedInfo === undefined) {
			obj.feedInfo = new Object();
		}
		if (obj.feedInfo.title === undefined) {
			obj.feedInfo.title = '';
		}
		if (obj.feedInfo.link === undefined) {
			obj.feedInfo.link = '';
		}
		if (obj.feedInfo.description === undefined) {
			obj.feedInfo.description = '';
		}
		// misc
		if (obj.history === undefined) {
			obj.history = new Array();
		}
		if (obj.lists === undefined) {
			obj.lists = new Array();
		}
		if (obj.calendar === undefined) {
			obj.calendar = new Object();
		}
	}

	readFile(f, (data) => {
		if (data === undefined) {
			var jstruct = new Object();
			initFeedStruct(jstruct);
			callback(jstruct);
		} else {
			var jstruct;
			try {
				jstruct = JSON.parse(data.toString());
			} catch (err) {
				jstruct = new Object();
			}
			initFeedStruct(jstruct);

			jstruct.stats.ctInfoReads++;
			jstruct.stats.whenLastInfoRead = new Date();

			callback(jstruct);
		}
	});
}
function readFeed(urlfeed, callback) {
	const starttime = new Date();
	const itemsInFeed = new Object(); // 6/3/15 by DW
	function getItemGuid(item) {
		function ok(val) {
			if (val != undefined) {
				if (val != 'null') {
					return (true);
				}
			}
			return (false);
		}
		if (ok(item.guid)) {
			return (item.guid);
		}
		let guid = '';
		if (ok(item.pubDate)) {
			guid += item.pubDate;
		}
		if (ok(item.link)) {
			guid += item.link;
		}
		if (ok(item.title)) {
			guid += item.title;
		}
		if (guid.length > 0) {
			guid = md5(guid);
		}
		return (guid);
	}
	initFeed(urlfeed, (feed) => {
		function writeFeed() {
			feed.stats.ctSecsLastRead = utils.secondsSince(starttime);
			writeFeedInfoFile(feed);
		}
		function feedError(message) {
			feed.stats.ctReadErrors++;
			feed.stats.ctConsecutiveReadErrors++;
			feed.stats.whenLastReadError = starttime;
			if (message !== undefined) {
				feed.stats.lastReadError = message;
			}
			writeFeed();

			feedstats.ctReadErrors++;
			feedstats.ctConsecutiveReadErrors++;
			feedstats.whenLastReadError = starttime;
		}
		function processFeedItem(item) {
			if (new Date(item.pubDate) > new Date(feed.stats.mostRecentPubDate)) {
				feed.stats.mostRecentPubDate = item.pubDate;
				feedstats.mostRecentPubDate = item.pubDate;
			}

			// copy cloud info, if present -- 6/3/15 by DW
			if (item.meta.cloud !== undefined) {
				if (item.meta.cloud.domain !== undefined) {
					feed.feedInfo.cloud = {
						domain: item.meta.cloud.domain,
						port: item.meta.cloud.port,
						path: item.meta.cloud.path,
						port: item.meta.cloud.port,
						registerProcedure: item.meta.cloud.registerprocedure,
						protocol: item.meta.cloud.protocol,
					};
					feedstats.cloud = {
						domain: item.meta.cloud.domain,
						port: item.meta.cloud.port,
						path: item.meta.cloud.path,
						port: item.meta.cloud.port,
						registerProcedure: item.meta.cloud.registerprocedure,
						protocol: item.meta.cloud.protocol,
					};
				}
			}

			// set flnew -- do the history thing
			const theGuid = getItemGuid(item);
			itemsInFeed[theGuid] = true; // 6/3/15 by DW
			flnew = true;
			for (let i = 0; i < feed.history.length; i++) {
				if (feed.history[i].guid == theGuid) { // we've already seen it
					flnew = false;
					break;
				}
			}
			if (flnew) { // add to the history array
				let obj = new Object(),
					flAddToRiver = true;
				obj.title = item.title;
				obj.link = item.link;
				obj.description = getItemDescription(item);
				obj.guid = theGuid;
				obj.when = starttime;
				feed.history[feed.history.length] = obj;

				// stats
				feed.stats.ctItems++;
				feed.stats.whenLastNewItem = starttime;

				feedstats.ctItems++;
				feedstats.whenLastNewItem = starttime;


				// copy feed info from item into the feed record -- 6/1/14 by DW
				feed.feedInfo.title = item.meta.title;
				feed.feedInfo.link = item.meta.link;
				feed.feedInfo.description = item.meta.description;
				// copy feeds info from item into feeds in-memory array element -- 6/1/14 by DW
				feedstats.title = item.meta.title;
				feedstats.text = item.meta.title;
				feedstats.htmlurl = item.meta.link;
				feedstats.description = item.meta.description;
				flFeedsArrayChanged = true;

				// exclude items that newly appear in feed but have a too-old pubdate
				if ((item.pubDate != null) && (new Date(item.pubDate) < utils.dateYesterday(feed.stats.mostRecentPubDate)) && (!flFirstRead)) {
					flAddToRiver = false;
					feed.stats.ctItemsTooOld++;
					feed.stats.whenLastTooOldItem = starttime;
				}

				if (flFirstRead) {
					if (config.flAddItemsFromNewSubs) {
						flAddToRiver = true;
					} else {
						flAddToRiver = false;
					}
				}

				if (flAddToRiver) {
					addToRiver(urlfeed, item);
					if (config.flWriteItemsToFiles) {
						const relpath = `${getFolderForFeed(urlfeed)}items/${utils.padWithZeros(feed.stats.itemSerialnum++, 3)}.json`;
						pushFileWriteQueue(relpath, utils.jsonStringify(item, true));
					}
				}
			}
		}
		function finishFeedProcessing() {
			// delete items in the history array that are no longer in the feed -- 6/3/15 by DW
			let ctHistoryItemsDeleted = 0;
			for (let i = feed.history.length - 1; i >= 0; i--) { // 6/3/15 by DW
				if (itemsInFeed[feed.history[i].guid] === undefined) { // it's no longer in the feed
					feed.history.splice(i, 1);
					ctHistoryItemsDeleted++;
				}
			}

			writeFeed();
			if (callback !== undefined) { // 6/5/15 by DW
				callback();
			}
		}
		function readJsonFeed(urlfeed, callback) {
			request(getRequestOptions(urlfeed), (err, response, body) => {
				if (err) {
					feedError(err.message);
				} else if (response.statusCode !== 200) {
					feedError(`readJsonFeed: response.statusCode == ${response.statusCode}`);
				} else {
					try {
						const jstruct = JSON.parse(body);
						const items = jstruct.rss.channel.item;
						for (let i = 0; i < items.length; i++) {
							const item = items[i];
							if (item.title === undefined) {
								item.title = null;
							}
							item.meta = {
								title: jstruct.rss.channel.title,
								link: jstruct.rss.channel.link,
								description: jstruct.rss.channel.description,
								cloud: jstruct.rss.channel.cloud,
							};

							if (item['source:outline'] !== undefined) { // it's already in the correct format for addToRiver, no conversion needed
								item.outline = item['source:outline'];
							}

							processFeedItem(item);
						}
						finishFeedProcessing();
					} catch (err) {
						feedError(`readJsonFeed: err.message == ${err.message}`);
					}
				}
				if (callback !== undefined) {
					callback();
				}
			});
		}
		if (feed.prefs.enabled) {
			var flFirstRead = feed.stats.ctReads == 0,
				feedstats;
			feedstats = findInFeedsArray(urlfeed); // the in-memory feed stats, stuff the scanner uses to figure out which feed to read next
			if (feedstats === undefined) {
				feedstats = addFeedToFeedsArray(urlfeed);
			}
			// stats
			serverStats.ctFeedReads++;
			serverStats.ctFeedReadsLastHour++;
			serverStats.ctFeedReadsThisRun++;
			serverStats.ctFeedReadsToday++;
			serverStats.lastFeedRead = urlfeed;
			serverStats.whenLastFeedRead = starttime;

			feed.stats.ctReads++;
			feed.stats.whenLastRead = starttime;

			feedstats.ctReads++;
			feedstats.whenLastRead = starttime;

			flFeedsArrayChanged = true;
			if (utils.beginsWith(urlfeed, 'feed://')) { // 8/13/15 by DW
				urlfeed = `http://${utils.stringDelete(urlfeed, 1, 7)}`;
			}

			if (utils.endsWith(urlfeed, '.json')) { // 6/13/17 by DW
				readJsonFeed(urlfeed);
			} else {
				const req = myRequestCall(urlfeed);
				const feedparser = new FeedParser();
				req.on('response', function (res) {
					const stream = this;
					if (res.statusCode == 200) {
						stream.pipe(feedparser);
					} else {
						feedError(`readFeed: res.statusCode == ${res.statusCode}`);
					}
				});
				req.on('error', (res) => {
					feedError();
				});
				feedparser.on('readable', function () {
					try {
						let item = this.read(),
							flnew;
						if (item !== null) { // 2/9/17 by DW
							processFeedItem(item);
						}
					} catch (err) {
						myConsoleLog(`readFeed: error == ${err.message}`);
					}
				});
				feedparser.on('error', () => {
					feedError();
				});
				feedparser.on('end', () => {
					finishFeedProcessing();
				});
			}
		}
	});
}
function readFeedIfSubscribed(urlfeed, callback) { // 8/18/17 by DW
	if (atLeastOneSubscriber(urlfeed)) {
		readFeed(urlfeed, callback);
	}
}
function subscribeToFeed(urlfeed, listname) {
	if ((urlfeed !== undefined) && (urlfeed.length > 0)) {
		const feedStats = findInFeedsArray(urlfeed);
		if (feedStats === undefined) { // new subscription
			addFeedToFeedsArray(urlfeed, listname);
		} else { // be sure this list is in its array of lists
			let fladd = true;
			for (let i = 0; i < feedStats.lists.length; i++) {
				if (feedStats.lists[i] == listname) {
					fladd = false;
					break;
				}
			}
			if (fladd) {
				feedStats.lists[feedStats.lists.length] = listname;
				flFeedsArrayChanged = true;
			}
		}
		addToFeedsInLists(urlfeed);
	}
}
function findNextFeedToRead(callback) {
	let now = new Date(),
		whenLeastRecent = now,
		itemLeastRecent;
	for (let i = 0; i < feedsArray.length; i++) {
		const item = feedsArray[i];
		if (atLeastOneSubscriber(item.url)) {
			const when = new Date(item.whenLastChosenToRead);
			if (when < whenLeastRecent) {
				itemLeastRecent = item;
				whenLeastRecent = when;
			}
		}
	}
	if (itemLeastRecent !== undefined) { // at least one element in array
		if (utils.secondsSince(itemLeastRecent.whenLastChosenToRead) >= (config.ctMinutesBetwBuilds * 60)) { // ready to read
			itemLeastRecent.whenLastChosenToRead = now;
			itemLeastRecent.ctTimesChosen++;
			flFeedsArrayChanged = true;
			if (callback !== undefined) {
				callback(itemLeastRecent.url);
			}
		}
	}
}
function getOneFeed(urlfeed, callback) { // 11/26/14 by DW
	initFeed(urlfeed, (feed) => {
		callback(feed);
	});
}
function readAllFeedsNow() { // 4/18/17 by DW
	function readNext(ix) {
		if (ix < feedsArray.length) {
			const item = feedsArray[ix];
			if (atLeastOneSubscriber(item.url)) {
				readFeed(item.url, () => {
					readNext(ix + 1);
				});
			} else {
				readNext(ix + 1);
			}
		}
	}
	readNext(0);
}
// lists
function listChanged(listname) {
	let flAdd = true;
	for (let i = 0; i < serverStats.listsThatChanged.length; i++) {
		if (serverStats.listsThatChanged[i] == listname) {
			flAdd = false;
		}
	}
	if (flAdd) {
		serverStats.listsThatChanged[serverStats.listsThatChanged.length] = listname;
	}
}
function getListFilename(listname) {
	return (`lists/${utils.stringPopExtension(listname)}/${config.listInfoFileName}`);
}
function initList(name, callback) {
	const f = getListFilename(name);
	function initListStruct(obj) {
		// prefs
		if (obj.prefs == undefined) {
			obj.prefs = new Object();
		}
		if (obj.prefs.enabled == undefined) {
			obj.prefs.enabled = true;
		}
		// stats
		if (obj.stats == undefined) {
			obj.stats = new Object();
		}
		if (obj.stats.ctReads == undefined) {
			obj.stats.ctReads = 0;
		}
		if (obj.stats.whenLastRead == undefined) {
			obj.stats.whenLastRead = new Date(0);
		}
		if (obj.stats.whenSubscribed == undefined) {
			obj.stats.whenSubscribed = new Date();
		}
		if (obj.stats.ctBlockedItems == undefined) {
			obj.stats.ctBlockedItems = 0;
		}
		// listInfo
		if (obj.listInfo == undefined) {
			obj.listInfo = new Object();
		}
		if (obj.listInfo.title == undefined) {
			obj.listInfo.title = '';
		}
		// misc
		if (obj.feeds == undefined) {
			obj.feeds = new Array();
		}
		if (obj.feedsBlocked == undefined) {
			obj.feedsBlocked = new Array();
		}
		if (obj.calendar == undefined) {
			obj.calendar = new Object();
		}
		if (obj.river == undefined) {
			obj.river = new Object();
		}
	}
	readFile(f, (data) => {
		if (data === undefined) {
			var jstruct = new Object();
			initListStruct(jstruct);
			callback(jstruct);
		} else {
			try {
				var jstruct = JSON.parse(data.toString());
				initListStruct(jstruct);
				callback(jstruct);
			} catch (err) {
				var jstruct = new Object();
				initListStruct(jstruct);
				callback(jstruct);
			}
		}
	});
}
function writeListInfoFile(listname, listObj, callback) {
	const f = getListFilename(listname);
	writeFile(f, utils.jsonStringify(listObj), callback);
}
function readIncludedList(listname, urloutline) { // 6/17/14 by DW
	const req = myRequestCall(urloutline);
	const opmlparser = new OpmlParser();
	req.on('response', function (res) {
		const stream = this;
		if (res.statusCode == 200) {
			stream.pipe(opmlparser);
		}
	});
	req.on('error', (res) => {
	});
	opmlparser.on('error', (error) => {
		myConsoleLog(`readIncludedList: opml parser error == ${error.message}`);
	});
	opmlparser.on('readable', function () {
		let outline;
		while (outline = this.read()) {
			switch (outline['#type']) {
			case 'feed':
				subscribeToFeed(outline.xmlurl, listname);
				break;
			}
		}
	});
	opmlparser.on('end', () => {
	});
}
function readOneList(listname, f, callback) {
	initList(listname, (listObj) => {
		const opmlparser = new OpmlParser();
		opmlparser.on('error', (error) => {
			myConsoleLog(`readOneList: opml parser error == ${error.message}`);
		});
		opmlparser.on('readable', function () {
			let outline;
			while (outline = this.read()) {
				switch (outline['#type']) {
				case 'feed':
					subscribeToFeed(outline.xmlurl, listname);
					break;
				}
				switch (outline.type) {
				case 'include':
					readIncludedList(listname, outline.url);
					break;
				}
			}
		});
		opmlparser.on('end', () => {
			writeListInfoFile(listname, listObj, () => {
				if (callback !== undefined) {
					callback();
				}
			});
		});

		fs.readFile(f, (err, data) => {
			if (err) {
				myConsoleLog(`readOneList: error reading list file == ${f}, err.message == ${err.message}`);
				if (callback !== undefined) {
					callback();
				}
			} else {
				opmlparser.end(data.toString());
			}
		});
	});
}
function readOneTxtList(listname, f, callback) {
	initList(listname, (listObj) => {
		fs.readFile(f, (err, data) => {
			if (err) {
				myConsoleLog(`readOneTxtList: error reading list file == ${f}, err.message == ${err.message}`);
			} else {
				let s = data.toString(),
					url = '';
				for (let i = 0; i < s.length; i++) {
					switch (s[i]) {
					case '\n': case '\r':
						if (url.length > 0) {
							subscribeToFeed(url, listname);
							url = '';
						}
						break;
					case '\t': // ignore tabs
						break;
					case ' ': // spaces only significant if inside a url
						if (url.length > 0) {
							url += ' ';
						}
						break;
					default:
						url += s[i];
						break;
					}
				}
				if (url.length > 0) {
					subscribeToFeed(url, listname);
				}
			}
			if (callback !== undefined) {
				callback();
			}
		});
	});
}
function readOneJsonList(listname, f, callback) {
	initList(listname, (listObj) => {
		fs.readFile(f, (err, data) => {
			if (err) {
				myConsoleLog(`readOneJsonList: error reading list file == ${f}, err.message == ${err.message}`);
			} else {
				try {
					const feedArray = JSON.parse(data.toString());
					for (let i = 0; i < feedArray.length; i++) {
						subscribeToFeed(feedArray[i], listname);
					}
				} catch (err) {
					myConsoleLog(`readOneJsonList: error parsing JSON list file == ${f}, err.message == ${err.message}`);
				}
			}
			if (callback !== undefined) {
				callback();
			}
		});
	});
}
function loadListsFromFolder(callback) {
	const now = new Date();
	for (let i = 0; i < feedsArray.length; i++) { // 6/7/14 by DW
		feedsArray[i].lists = [];
	}
	serverStats.ctListFolderReads++;
	serverStats.whenLastListFolderRead = now;
	serverStats.listNames = new Array();
	feedsInLists = new Object();
	listFiles(config.listsFolder, (f) => {
		if (f === undefined) { // no more files
			flFirstListLoad = false;
			if (callback !== undefined) {
				callback();
			}
		} else {
			function addListToStats(listname) {
				serverStats.listNames[serverStats.listNames.length] = listname;
				flStatsChanged = true;
			}
			const listname = utils.stringLastField(f, '/'); // something like myList.opml
			const ext = utils.stringLower(utils.stringLastField(listname, '.'));
			switch (ext) {
			case 'opml':
				readOneList(listname, f);
				addListToStats(listname);
				break;
			case 'txt':
				readOneTxtList(listname, f);
				addListToStats(listname);
				break;
			case 'json':
				readOneJsonList(listname, f);
				addListToStats(listname);
				break;
			}
		}
	});
}
function getAllLists(callback) {
	const theLists = new Array();
	function getOneFile(ix) {
		if (ix >= serverStats.listNames.length) {
			callback(theLists);
		} else {
			let fname = serverStats.listNames[ix],
				f = config.listsFolder + fname;
			fs.readFile(f, (err, data) => {
				if (err) {
					myConsoleLog(`getAllLists: error reading list ${f} err.message == ${err.message}`);
				} else {
					theLists[theLists.length] = {
						listname: fname,
						opmltext: data.toString(),
					};
				}
				getOneFile(ix + 1);
			});
		}
	}
	getOneFile(0);
}
function getOneList(fname, callback) {
	const f = config.listsFolder + fname;
	fs.readFile(f, (err, data) => {
		if (err) {
			myConsoleLog(`getOneList: f == ${f}, err.message == ${err.message}`);
			callback(undefined);
		} else {
			callback(data.toString());
		}
	});
}
function saveSubscriptionList(listname, xmltext, callback) {
	let f = config.listsFolder + listname,
		now = new Date();
	fsSureFilePath(f, () => {
		fs.writeFile(f, xmltext, (err) => {
			if (err) {
				myConsoleLog(`saveSubscriptionList: f == ${f}, err.message == ${err.message}`);
			}
			if (callback !== undefined) {
				callback();
			}
		});
	});
}
// each list's river -- 2/2/16 by DW
const allTheRivers = new Object();

function getRiverDataFilename(listname) {
	return (`lists/${utils.stringPopExtension(listname)}/${config.riverDataFileName}`);
}
function initRiverData(theData) {
	if (theData.ctRiverBuilds === undefined) {
		theData.ctRiverBuilds = 0;
		theData.flDirty = true;
	}
	if (theData.whenLastRiverBuild === undefined) {
		theData.whenLastRiverBuild = new Date(0);
		theData.flDirty = true;
	}
}
function getRiverData(listname, callback) {
	if (allTheRivers[listname] !== undefined) { // we already have it in memory
		if (callback !== undefined) {
			const jstruct = allTheRivers[listname];
			initRiverData(jstruct);
			callback(jstruct);
		}
	} else { // read it from the file into allTheRivers struct
		const f = getRiverDataFilename(listname);
		readFile(f, (data) => {
			let jstruct = {
				ctItemsAdded: 0,
				whenLastItemAdded: new Date(0),
				ctSaves: 0,
				whenLastSave: new Date(0),
				flDirty: true,
				ctRiverBuilds: 0,
				whenLastRiverBuild: new Date(0),
				items: new Array(),
			};
			if (data !== undefined) {
				try {
					jstruct = JSON.parse(data.toString());
				} catch (err) {
				}
			}
			initRiverData(jstruct);
			allTheRivers[listname] = jstruct;
			if (callback !== undefined) {
				callback(allTheRivers[listname]);
			}
		});
	}
}
function addRiverItemToList(listname, item, callback) {
	getRiverData(listname, (jstruct) => {
		jstruct.items[jstruct.items.length] = item; // 3/14/16 by DW
		if (jstruct.items.length > config.maxRiverItems) {
			jstruct.items.shift();
		}
		jstruct.ctItemsAdded++;
		jstruct.whenLastItemAdded = new Date();
		jstruct.flDirty = true;
		if (callback !== undefined) {
			callback();
		}
	});
}
function saveChangedRiverStructs() {
	for (const x in allTheRivers) {
		const item = allTheRivers[x];
		if (item.flDirty) {
			const f = getRiverDataFilename(x);
			item.flDirty = false;
			item.ctSaves++;
			item.whenLastSave = new Date();
			writeFile(f, utils.jsonStringify(item));
		}
	}
}

function buildOneRiver(listname, callback) {
	let theRiver = new Object(),
		starttime = new Date(),
		ctitems = 0,
		titles = new Object(),
		ctDuplicatesSkipped = 0;
	theRiver.updatedFeeds = new Object();
	theRiver.updatedFeeds.updatedFeed = new Array();
	getRiverData(listname, (myRiverData) => { // an array of all the items in the river
		let lastfeedurl,
			theRiverFeed,
			flThisFeedInList = true;
		function finishBuild() {
			let jsontext;

			myRiverData.ctRiverBuilds++;
			myRiverData.whenLastRiverBuild = starttime;
			myRiverData.flDirty = true;

			theRiver.metadata = {
				name: listname,
				docs: 'http://scripting.com/stories/2010/12/06/innovationRiverOfNewsInJso.html',
				secs: utils.secondsSince(starttime),
				ctBuilds: myRiverData.ctRiverBuilds,
				ctDuplicatesSkipped,
				whenGMT: starttime.toUTCString(),
				whenLocal: starttime.toLocaleString(),
				aggregator: `${myProductName} v${myVersion}`,
			};
			jsontext = utils.jsonStringify(theRiver, true);
			jsontext = `onGetRiverStream (${jsontext})`;
			let fname = `${utils.stringPopLastField(listname, '.')}.js`,
				f = config.riversFolder + fname;
			fsSureFilePath(f, () => {
				fs.writeFile(f, jsontext, (err) => {
					if (err) {
						myConsoleLog(`finishBuild: f == ${f}, error == ${err.message}`);
					} else {
					}
					serverStats.ctRiverJsonSaves++;
					serverStats.whenLastRiverJsonSave = starttime;
					flStatsChanged = true;
					notifyWebSocketListeners(`updated ${listname}`);
					callBuildRiverCallbacks(fname, jsontext); // 4/23/17 by DW
					if (callback !== undefined) {
						callback();
					}
				});
			});
		}
		for (let i = myRiverData.items.length - 1; i >= 0; i--) {
			var story = myRiverData.items[i],
				flskip = false,
				reducedtitle;
			if (config.flSkipDuplicateTitles) { // 5/29/14 by DW
				reducedtitle = utils.trimWhitespace(utils.stringLower(story.title));
				if (reducedtitle.length > 0) { // 6/6/14 by DW
					if (titles[reducedtitle] != undefined) { // duplicate
						ctDuplicatesSkipped++;
						flskip = true;
					}
				}
			}
			if (!flskip) {
				if (story.feedUrl != lastfeedurl) {
					const feedstats = findInFeedsArray(story.feedUrl);
					const ix = theRiver.updatedFeeds.updatedFeed.length;
					theRiver.updatedFeeds.updatedFeed[ix] = new Object();
					theRiverFeed = theRiver.updatedFeeds.updatedFeed[ix];

					theRiverFeed.feedTitle = feedstats.title;
					theRiverFeed.feedUrl = story.feedUrl;
					theRiverFeed.websiteUrl = feedstats.htmlurl;
					// description
					if (feedstats.description == undefined) {
						theRiverFeed.feedDescription = '';
					} else {
						theRiverFeed.feedDescription = feedstats.description;
					}
					// whenLastUpdate -- 6/7/15 by DW
					if (story.when !== undefined) {
						theRiverFeed.whenLastUpdate = new Date(story.when).toUTCString();
					} else {
						theRiverFeed.whenLastUpdate = new Date(feedstats.whenLastNewItem).toUTCString();
					}
					theRiverFeed.item = new Array();

					lastfeedurl = story.feedUrl;
				}

				let thePubDate = story.pubdate; // 2/10/16 by DW
				if (thePubDate == null) {
					thePubDate = starttime;
				}

				const theItem = {
					title: story.title,
					link: story.link,
					body: story.description,
					pubDate: new Date(thePubDate).toUTCString(),
					permaLink: story.permalink,
				};
				if (story.outline != undefined) { // 7/16/14 by DW
					theItem.outline = story.outline;
				}
				if (story.comments.length > 0) { // 6/7/14 by DW
					theItem.comments = story.comments;
				}
				// enclosure -- 5/30/14 by DW
				if (story.enclosure != undefined) {
					let flgood = true;

					if ((story.enclosure.type == undefined) || (story.enclosure.length === undefined)) { // both are required
						flgood = false; // sorry! :-(
					} else if (utils.stringCountFields(story.enclosure.type, '/') < 2) { // something like "image" -- not a valid type
						flgood = false; // we read the spec, did you? :-)
					}

					if (flgood) {
						theItem.enclosure = [story.enclosure];
					}
				}
				// id
				if (story.id == undefined) {
					theItem.id = '';
				} else {
					theItem.id = utils.padWithZeros(story.id, 7);
				}

				theRiverFeed.item[theRiverFeed.item.length] = theItem;

				if (config.flSkipDuplicateTitles) { // 5/29/14 by DW -- add the title to the titles object
					titles[reducedtitle] = true;
				}
			}
		}
		finishBuild();
	});
}


// keep a river for each feed -- 6/29/17 by DW
const allTheFeedRivers = new Object();

function readRiverData(f, callback) {
	readFile(f, (data) => {
		let jstruct = {
			ctItemsAdded: 0,
			whenLastItemAdded: new Date(0),
			ctSaves: 0,
			whenLastSave: new Date(0),
			flDirty: true,
			ctRiverBuilds: 0,
			whenLastRiverBuild: new Date(0),
			items: new Array(),
		};
		if (data !== undefined) {
			try {
				jstruct = JSON.parse(data.toString());
			} catch (err) {
			}
		}
		initRiverData(jstruct);
		if (callback !== undefined) {
			callback(jstruct);
		}
	});
}
function getFeedRiver(urlfeed, callback) {
	if (allTheFeedRivers[urlfeed] !== undefined) {
		const theRiver = allTheFeedRivers[urlfeed];
		theRiver.ctAccesses++;
		theRiver.whenLastAccess = new Date();
		callback(theRiver.jstruct);
	} else {
		const f = `${getFolderForFeed(urlfeed)}feedRiver.json`;
		readRiverData(f, (jstruct) => {
			allTheFeedRivers[urlfeed] = {
				f,
				whenLastAccess: new Date(),
				ctAccesses: 1,
				flChanged: true,
				jstruct,
			};
			callback(jstruct);
		});
	}
}
function addItemToFeedRiver(urlfeed, item, itemFromParser) {
	if (config.flSaveFeedRivers) {
		getFeedRiver(urlfeed, (jstruct) => {
			const itemToPush = new Object();
			utils.copyScalars(item, itemToPush);
			itemToPush.fullDescription = itemFromParser.description;
			if (item.outline !== undefined) { // 7/6/17 by DW
				itemToPush.outline = item.outline;
			}
			jstruct.items.push(itemToPush);

			while (jstruct.items.length > config.maxRiverItems) {
				jstruct.items.shift();
			}

			jstruct.ctItemsAdded++;
			jstruct.whenLastItemAdded = new Date();
			jstruct.flDirty = true;
		});
	}
}
function saveChangedFeedRivers() {
	for (const x in allTheFeedRivers) {
		let theRiver = allTheFeedRivers[x],
			item = theRiver.jstruct;
		if (item.flDirty) {
			item.flDirty = false;
			item.ctSaves++;
			item.whenLastSave = new Date();
			writeFile(theRiver.f, utils.jsonStringify(item));
		}
	}
}
function tossOldFeedRivers() { // delete rivers that haven't been accessed in the last minute
	for (const x in allTheFeedRivers) {
		if (utils.secondsSince(allTheFeedRivers[x].whenLastAccess) > 60) {
			delete allTheFeedRivers[x];
		}
	}
}
function getFeedRiverForServer(urlfeed, callback) {
	getFeedRiver(urlfeed, (jstruct) => {
		const stats = findInFeedsArray(urlfeed);
		if (stats === undefined) {
			callback(returnstruct);
		} else {
			var returnstruct = {
				title: stats.title,
				link: stats.htmlurl,
				description: stats.description,
				url: stats.url,
				items: new Array(),
				stats: {
					ctReads: stats.ctReads,
					ctItems: stats.ctItems,
					ctReadErrors: stats.ctReadErrors,
					ctConsecutiveReadErrors: stats.ctConsecutiveReadErrors,
					whenLastNewItem: stats.whenLastNewItem,
					whenLastReadError: stats.whenLastReadError,
					whenLastRead: stats.whenLastRead,
					mostRecentPubDate: stats.mostRecentPubDate,
					cloud: {
						ctCloudRenew: stats.ctCloudRenew,
						ctCloudRenewErrors: stats.ctCloudRenewErrors,
						ctConsecutiveCloudRenewErrors: stats.ctConsecutiveCloudRenewErrors,
						whenLastCloudRenew: stats.whenLastCloudRenew,
						whenLastCloudRenewError: stats.whenLastCloudRenewError,
					},
				},
			};
			for (let i = jstruct.items.length - 1; i >= 0; i--) {
				returnstruct.items.unshift(jstruct.items[i]);
			}
			callback(returnstruct);
		}
	});
}


// podcasts -- 4/17/17 by DW
let podcastQueue = new Array(),
	ctConcurrentPodcastDownloads = 0;

function checkPodcastQueue() {
	if (config.flDownloadPodcasts) {
		if (podcastQueue.length > 0) {
			if (ctConcurrentPodcastDownloads < config.maxConcurrentPodcastDownloads) {
				const item = podcastQueue.shift(); // remove and return first element
				ctConcurrentPodcastDownloads++;
				downloadBigFile(item.url, item.f, item.pubdate, () => {
					ctConcurrentPodcastDownloads--;
				});
			}
		}
	}
}
function pushPodcastDownloadQueue(url, f, pubdate) {
	podcastQueue[podcastQueue.length] = {
		url,
		f,
		pubdate,
	};
	flPodcastQueueChanged = true;
}
function downloadPodcast(itemFromRiver, urlfeed) { // 4/17/17 by DW
	function goodFilename(fname) {
		fname = cleanFilenameForPlatform(fname);
		fname = utils.maxStringLength(fname, config.maxFileNameLength, false, false);
		return (fname);
	}
	if (config.flDownloadPodcasts) {
		if (itemFromRiver.enclosure !== undefined) {
			if (utils.beginsWith(itemFromRiver.enclosure.type, 'audio/')) {
				const subfoldername = goodFilename(getFeedTitle(urlfeed));
				let fname = utils.stringLastField(itemFromRiver.enclosure.url, '/');
				fname = utils.stringNthField(fname, '?', 1);
				const extension = utils.stringLastField(fname, '.');
				const f = `${config.podcastsFolder + subfoldername}/${itemFromRiver.id}.${extension}`;
				pushPodcastDownloadQueue(itemFromRiver.enclosure.url, f, itemFromRiver.pubdate);
			}
		}
	}
}
// rivers
let todaysRiver = [],
	flRiverChanged = false,
	dayRiverCovers = new Date();

function getItemDescription(item) {
	let s = item.description;
	if (s == null) {
		s = '';
	}
	s = utils.stripMarkup(s);
	s = utils.trimWhitespace(s);
	if (s.length > config.maxBodyLength) {
		s = utils.trimWhitespace(utils.maxStringLength(s, config.maxBodyLength));
	}
	return (s);
}
function addToRiver(urlfeed, itemFromParser, callback) {
	let now = new Date(),
		item = new Object();
	// copy selected elements from the object from feedparser, into the item for the river
	function convertOutline(jstruct) { // 7/16/14 by DW
		let theNewOutline = {},
			atts,
			subs;
		if (jstruct['source:outline'] != undefined) {
			if (jstruct['@'] != undefined) {
				atts = jstruct['@'];
				subs = jstruct['source:outline'];
			} else {
				atts = jstruct['source:outline']['@'];
				subs = jstruct['source:outline']['source:outline'];
			}
		} else {
			atts = jstruct['@'];
			subs = undefined;
		}
		for (var x in atts) {
			theNewOutline[x] = atts[x];
		}
		if (subs != undefined) {
			theNewOutline.subs = [];
			if (subs instanceof Array) {
				for (let i = 0; i < subs.length; i++) {
					theNewOutline.subs[i] = convertOutline(subs[i]);
				}
			} else {
				theNewOutline.subs = [];
				theNewOutline.subs[0] = {};
				for (var x in subs['@']) {
					theNewOutline.subs[0][x] = subs['@'][x];
				}
			}
		}
		return (theNewOutline);
	}
	function newConvertOutline(jstruct) { // 10/16/14 by DW
		const theNewOutline = {};
		if (jstruct['@'] != undefined) {
			utils.copyScalars(jstruct['@'], theNewOutline);
		}
		if (jstruct['source:outline'] != undefined) {
			if (jstruct['source:outline'] instanceof Array) {
				const theArray = jstruct['source:outline'];
				theNewOutline.subs = [];
				for (let i = 0; i < theArray.length; i++) {
					theNewOutline.subs[theNewOutline.subs.length] = newConvertOutline(theArray[i]);
				}
			} else {
				theNewOutline.subs = [
					newConvertOutline(jstruct['source:outline']),
				];
			}
		}
		return (theNewOutline);
	}
	function getString(s) {
		if (s == null) {
			s = '';
		}
		return (utils.stripMarkup(s));
	}
	function getDate(d) {
		if (d == null) {
			d = now;
		}
		return (new Date(d));
	}

	item.title = getString(itemFromParser.title);
	item.link = getString(itemFromParser.link);
	item.description = getItemDescription(itemFromParser);

	// permalink -- updated 5/30/14 by DW
	if (itemFromParser.permalink == undefined) {
		item.permalink = '';
	} else {
		item.permalink = itemFromParser.permalink;
	}

	// enclosure -- 5/30/14 by DW
	if (itemFromParser.enclosures != undefined) { // it's an array, we want the first one
		item.enclosure = itemFromParser.enclosures[0];
	}
	// outline -- 6/14/17 by DW
	if (itemFromParser.outline !== undefined) {
		item.outline = itemFromParser.outline;
	} else if (itemFromParser['source:outline'] != undefined) {
		item.outline = newConvertOutline(itemFromParser['source:outline']);
	}
	item.pubdate = getDate(itemFromParser.pubDate);
	item.comments = getString(itemFromParser.comments);
	item.feedUrl = urlfeed;
	item.when = now; // 6/7/15 by DW
	item.aggregator = `${myProductName} v${myVersion}`;
	item.id = serverStats.serialnum++; // 5/28/14 by DW
	if (config.flMaintainCalendarStructure) {
		todaysRiver[todaysRiver.length] = item;
	}
	flRiverChanged = true;
	// stats
	serverStats.ctStoriesAdded++;
	serverStats.ctStoriesAddedThisRun++;
	serverStats.ctStoriesAddedToday++;
	serverStats.whenLastStoryAdded = now;
	serverStats.lastStoryAdded = item;
	// show in console
	let storyTitle = itemFromParser.title;
	if (storyTitle == null) {
		storyTitle = utils.maxStringLength(utils.stripMarkup(itemFromParser.description), 80);
	}
	myConsoleLog(`${getFeedTitle(urlfeed)}: ${storyTitle}`);
	// add the item to each of the lists it belongs to, and mark the river as changed
	let feedstats = findInFeedsArray(urlfeed),
		listname;
	if (feedstats !== undefined) {
		for (let i = 0; i < feedstats.lists.length; i++) {
			listname = feedstats.lists[i];
			listChanged(listname);
			addRiverItemToList(listname, item);
		}
	}
	// add the item to the feed's river -- 6/29/17 by DW
	addItemToFeedRiver(urlfeed, item, itemFromParser);

	downloadPodcast(item, urlfeed); // 4/17/17 by DW

	if (config.newItemCallback !== undefined) { // 5/17/17 by DW
		config.newItemCallback(urlfeed, itemFromParser, item);
	}

	callAddToRiverCallbacks(urlfeed, itemFromParser, item); // 6/19/15 by DW

	notifyWebSocketListeners(`item ${utils.jsonStringify(item)}`);
}
function getCalendarPath(d) {
	if (d === undefined) {
		d = dayRiverCovers;
	}
	return (`calendar/${utils.getDatePath(d, false)}.json`);
}
function saveTodaysRiver(callback) {
	if (config.flMaintainCalendarStructure) {
		serverStats.ctRiverSaves++;
		serverStats.whenLastRiverSave = new Date();
		flStatsChanged = true;
		writeStats(getCalendarPath(), todaysRiver, callback);
	}
}
function loadTodaysRiver(callback) {
	if (config.flMaintainCalendarStructure) {
		readStats(getCalendarPath(), todaysRiver, () => {
			if (callback !== undefined) {
				callback();
			}
		});
	} else if (callback !== undefined) {
		callback();
	}
}
function checkRiverRollover() {
	const now = new Date();
	function roll() {
		if (config.flMaintainCalendarStructure) {
			todaysRiver = new Array(); // clear it out
			dayRiverCovers = now;
			saveTodaysRiver();
		}
		serverStats.ctHitsToday = 0;
		serverStats.ctFeedReadsToday = 0;
		serverStats.ctStoriesAddedToday = 0;
		flStatsChanged = true;
	}
	if (utils.secondsSince(serverStats.whenLastStoryAdded) >= 60) {
		if (!utils.sameDay(now, dayRiverCovers)) { // rollover
			if (flRiverChanged) {
				saveTodaysRiver(roll);
			} else {
				roll();
			}
		}
	}
}
function buildChangedRivers(callback) {
	if (serverStats.listsThatChanged.length > 0) {
		let listname = serverStats.listsThatChanged.shift(),
			whenstart = new Date();
		flStatsChanged = true;
		buildOneRiver(listname, () => {
			myConsoleLog(`buildChangedRivers: listname == ${listname}, secs == ${utils.secondsSince(whenstart)}`);
			buildChangedRivers(callback);
		});
	} else if (callback !== undefined) {
		callback();
	}
}
function buildAllRivers() {
	for (let i = 0; i < serverStats.listNames.length; i++) {
		listChanged(serverStats.listNames[i]);
	}
	buildChangedRivers();
}
function getOneRiver(fname, callback) {
	const name = utils.stringPopLastField(fname, '.'); // get rid of .opml extension if present
	const f = `${config.riversFolder + name}.js`;
	fs.readFile(f, (err, data) => {
		if (err) {
			myConsoleLog(`getOneRiver: f == ${f}, err.message == ${err.message}`);
			callback(undefined);
		} else {
			callback(data.toString());
		}
	});
}
// misc
function cleanFilenameForPlatform(s) {
	switch (process.platform) {
	case 'win32':
		s = utils.replaceAll(s, '/', '_');
		s = utils.replaceAll(s, '?', '_');
		s = utils.replaceAll(s, ':', '_');
		s = utils.replaceAll(s, '<', '_');
		s = utils.replaceAll(s, '>', '_');
		s = utils.replaceAll(s, '"', '_');
		s = utils.replaceAll(s, '\\', '_');
		s = utils.replaceAll(s, '|', '_');
		s = utils.replaceAll(s, '*', '_');
		break;
	case 'darwin':
		s = utils.replaceAll(s, '/', ':');
		break;
	}
	return (s);
}
function downloadBigFile(url, f, pubDate, callback) { // 4/17/17 by DW
	fsSureFilePath(f, () => {
		const theStream = fs.createWriteStream(f);
		theStream.on('finish', () => {
			console.log(`downloadBigFile: finished writing to f == ${f}`);
			pubDate = new Date(pubDate);
			fs.utimes(f, pubDate, pubDate, () => {
			});
			if (callback !== undefined) {
				callback();
			}
		});
		request.get(url)
			.on('error', (err) => {
				console.log(err);
			})
			.pipe(theStream);
	});
}
function httpReadUrl(url, callback) { // 11/16/16 by DW
	request(url, (error, response, body) => {
		if (!error && (response.statusCode == 200)) {
			callback(body);
		}
	});
}
function endsWithChar(s, chPossibleEndchar) {
	if ((s === undefined) || (s.length == 0)) {
		return (false);
	}
	return (s[s.length - 1] == chPossibleEndchar);
}
function fsSureFilePath(path, callback) {
	const splits = path.split('/');
	path = ''; // 1/8/15 by DW
	if (splits.length > 0) {
		function doLevel(levelnum) {
			if (levelnum < (splits.length - 1)) {
				path += `${splits[levelnum]}/`;
				fs.exists(path, (flExists) => {
					if (flExists) {
						doLevel(levelnum + 1);
					} else {
						fs.mkdir(path, undefined, () => {
							doLevel(levelnum + 1);
						});
					}
				});
			} else if (callback != undefined) {
				callback();
			}
		}
		doLevel(0);
	} else if (callback != undefined) {
		callback();
	}
}
function saveStats() {
	serverStats.ctStatsSaves++;
	serverStats.whenLastStatsSave = new Date();
	writeStats(config.statsFilePath, serverStats);
}
function getFeedMetadata(url, callback) { // 12/1/14 by DW
	let req = myRequestCall(url),
		feedparser = new FeedParser();
	req.on('response', function (res) {
		const stream = this;
		if (res.statusCode == 200) {
			stream.pipe(feedparser);
		} else {
			callback(undefined);
		}
	});
	req.on('error', (res) => {
		callback(undefined);
	});
	feedparser.on('readable', function () {
		const item = this.read();
		callback(item.meta);
	});
	feedparser.on('end', () => {
		callback(undefined);
	});
	feedparser.on('error', () => {
		callback(undefined);
	});
}
// rsscloud
function pleaseNotify(urlServer, domain, port, path, urlFeed, feedstats, callback) { // 6/4/15 by DW
	const now = new Date();
	const theRequest = {
		url: urlServer,
		followRedirect: true,
		headers: { Accept: 'application/json' },
		method: 'POST',
		form: {
			port,
			path,
			url1: urlFeed,
			protocol: 'http-post',
		},
	};

	myConsoleLog(`pleaseNotify: urlFeed == ${urlFeed}`);
	feedstats.whenLastCloudRenew = now;
	feedstats.ctCloudRenew++;
	flFeedsArrayChanged = true; // because we modified feedstats

	request(theRequest, (err, response, body) => {
		function recordErrorStats(message) {
			feedstats.ctCloudRenewErrors++; // counts the number of communication errors
			feedstats.ctConsecutiveCloudRenewErrors++;
			feedstats.whenLastCloudRenewError = now;
			feedstats.lastCloudRenewError = message;
			flFeedsArrayChanged = true;
		}
		try {
			let flskip = false;

			if (err) {
				flskip = true;
				if (callback) {
					callback(err.message);
				}
			} else if (!body.success) {
				flskip = true;
				if (callback) {
					callback(body.msg);
				}
			}

			if (flskip) {
				recordErrorStats(err.message);
			} else {
				feedstats.ctConsecutiveCloudRenewErrors = 0;
				flFeedsArrayChanged = true; // because we modified feedstats
				if (callback) {
					callback('It worked.');
				}
			}
		} catch (err) {
			recordErrorStats(err.message);
			if (callback) {
				callback(err.message);
			}
		}
	});
}
function renewNextSubscription() { // 6/4/15 by DW
	if (config.flRequestCloudNotify && config.flHttpEnabled) {
		let theFeed;
		for (let i = 0; i < feedsArray.length; i++) {
			theFeed = feedsArray[i];
			if (theFeed.cloud !== undefined) {
				if (utils.secondsSince(theFeed.whenLastCloudRenew) > (23 * 60 * 60)) { // ready to be renewed
					const urlCloudServer = `http://${theFeed.cloud.domain}:${theFeed.cloud.port}${theFeed.cloud.path}`;

					serverStats.ctRssCloudRenews++;
					serverStats.whenLastRssCloudRenew = new Date();
					flStatsChanged = true;

					pleaseNotify(urlCloudServer, undefined, config.httpPort, '/feedupdated', theFeed.url, theFeed, () => {
					});
					return; // we renew at most one each time we're called
				}
			}
		}
	}
}
function rssCloudFeedUpdated(urlFeed) { // 6/4/15 by DW
	const feedstats = findInFeedsArray(urlFeed);
	if (feedstats === undefined) {
		myConsoleLog(`\nrssCloudFeedUpdated: url == ${urlFeed}, but we're not subscribed to this feed, so it wasn't read.\n`);
	} else {
		const now = new Date();
		serverStats.whenLastRssCloudUpdate = now;
		serverStats.ctRssCloudUpdates++;
		serverStats.urlFeedLastCloudUpdate = urlFeed;
		flStatsChanged = true;
		myConsoleLog(`\nrssCloudFeedUpdated: ${urlFeed}`);
		readFeedIfSubscribed(urlFeed, () => {
		});
	}
}
function renewThisFeedNow(urlFeed, callback) { // 6/14/17 by DW
	const theFeed = findInFeedsArray(urlFeed);
	if (theFeed.cloud === undefined) {
		if (callback !== undefined) {
			callback(`Can't renew the subscription because the feed, "${urlFeed}" is not cloud-aware.`);
		}
	} else {
		const urlCloudServer = `http://${theFeed.cloud.domain}:${theFeed.cloud.port}${theFeed.cloud.path}`;
		pleaseNotify(urlCloudServer, undefined, config.httpPort, '/feedupdated', theFeed.url, theFeed, (message) => {
			if (callback !== undefined) {
				callback(`We sent the request to ${urlCloudServer}.`);
			}
		});
	}
}
// callbacks
let localStorage = {
};
let lastLocalStorageJson = '';

function loadLocalStorage(callback) {
	readFile(config.localStoragePath, (data) => {
		if (data !== undefined) {
			try {
				const s = data.toString();
				localStorage = JSON.parse(s);
				lastLocalStorageJson = s;
			} catch (err) {
				myConsoleLog(`loadLocalStorage: error reading localStorage == ${err.message}`);
			}
		}
		if (callback != undefined) {
			callback();
		}
	});
}
function writeLocalStorageIfChanged() {
	const s = utils.jsonStringify(localStorage);
	if (s != lastLocalStorageJson) {
		lastLocalStorageJson = s;
		writeFile(config.localStoragePath, s);
	}
}
function todaysRiverChanged() { // 6/21/15 by DW -- callback scripts, call this to be sure your changes get saved
	flRiverChanged = true;
}
function runUserScript(s, dataforscripts, scriptName) {
	try {
		if (dataforscripts !== undefined) {
			eval(`with (${JSON.stringify(dataforscripts)}) { ${s} }`);
		} else {
			eval(s);
		}
	} catch (err) {
		myConsoleLog(`runUserScript: error running "${scriptName}" == ${err.message}`);
	}
}
function runScriptsInFolder(path, dataforscripts, callback) {
	fsSureFilePath(path, () => {
		fs.readdir(path, (err, list) => {
			if (list !== undefined) { // 3/29/17 by DW
				for (let i = 0; i < list.length; i++) {
					const fname = list[i];
					if (utils.endsWith(fname.toLowerCase(), '.js')) {
						var f = path + fname;
						fs.readFile(f, (err, data) => {
							if (err) {
								myConsoleLog(`runScriptsInFolder: error == ${err.message}`);
							} else {
								runUserScript(data.toString(), dataforscripts, f);
							}
						});
					}
				}
			}
			if (callback != undefined) {
				callback();
			}
		});
	});
}
function callAddToRiverCallbacks(urlfeed, itemFromParser, itemFromRiver) {
	const dataforscripts = {
		urlfeed,
		itemFromParser,
		itemFromRiver,
	};
	runScriptsInFolder(config.addToRiverCallbacksFolder, dataforscripts, () => {
	});
}
function callBuildRiverCallbacks(fname, jsontext) {
	const dataforscripts = {
		fname,
		jsontext,
	};
	runScriptsInFolder(config.buildRiverCallbacksFolder, dataforscripts, () => {
	});
}
// websockets
let theWsServer;

function countOpenSockets() {
	if (theWsServer === undefined) { // 12/18/15 by DW
		return (0);
	}
	return (theWsServer.connections.length);
}

function notifyWebSocketListeners(s) {
	if (theWsServer !== undefined) {
		let ctUpdates = 0;
		for (let i = 0; i < theWsServer.connections.length; i++) {
			const conn = theWsServer.connections[i];
			if (conn.riverServerData !== undefined) { // it's one of ours
				try {
					conn.sendText(s);
					ctUpdates++;
				} catch (err) {
				}
			}
		}
	}
	if (config.notifyListenersCallback !== undefined) { // 3/25/17 by DW
		config.notifyListenersCallback(s);
	}
}
function handleWebSocketConnection(conn) {
	const now = new Date();

	function logToConsole(conn, verb, value) {
		getDomainName(conn.socket.remoteAddress, (theName) => { // log the request
			let freemem = gigabyteString(os.freemem()),
				method = `WS:${verb}`,
				now = new Date();
			if (theName === undefined) {
				theName = conn.socket.remoteAddress;
			}
			myConsoleLog(`${now.toLocaleTimeString()} ${freemem} ${method} ${value} ${theName}`);
			conn.chatLogData.domain = theName;
		});
	}

	conn.riverServerData = {
		whenStarted: now,
	};
	conn.on('text', (s) => {

	});
	conn.on('close', () => {
	});
	conn.on('error', (err) => {
	});
}
function startWebSocketServer() {
	if (config.flWebSocketEnabled) {
		if (config.webSocketPort !== undefined) {
			myConsoleLog(`startWebSocketServer: websockets port is ${config.webSocketPort}`);
			try {
				theWsServer = websocket.createServer(handleWebSocketConnection);
				theWsServer.listen(config.webSocketPort);
			} catch (err) {
				myConsoleLog(`startWebSocketServer: err.message == ${err.message}`);
			}
		}
	}
}


// http server
function getServerStatsJson() { // 3/25/17by DW
	serverStats.ctSecsSinceLastStart = utils.secondsSince(serverStats.whenLastStart);
	serverStats.ctSecsSinceLastFeedReed = utils.secondsSince(serverStats.whenLastFeedRead);
	return (utils.jsonStringify(serverStats, true));
}
function returnThroughTemplate(htmltext, title, callback) {
	fs.readFile(config.templatePath, (err, data) => {
		let templatetext;
		if (err) {
			myConsoleLog(`returnThroughTemplate: error reading config.templatePath == ${config.templatePath}, err.message == ${err.message}`);
			templatetext = '';
		} else {
			templatetext = data.toString();
		}
		const pagetable = {
			text: htmltext,
			title,
		};
		const pagetext = utils.multipleReplaceAll(templatetext, pagetable, false, '[%', '%]');
		callback(pagetext);
	});
}
function viewFeedList(callback) {
	let htmltext = '',
		indentlevel = 0;
	function dateString(d) {
		d = new Date(d);
		return (`${d.getMonth() + 1}/${d.getDate()}`);
	}
	function add(s) {
		htmltext += `${utils.filledString('\t', indentlevel) + s}\n`;
	}
	add('<table class="feedTable">'); indentlevel++;

	// column titles
	add('<tr>'); indentlevel++;
	add('<td class="tdFeedTitle"><b>Title</b></td>');
	add('<td class="tdFeedCt"><b>Stories</b></td>');
	add('<td class="tdFeedDate"><b>When</b></td>');
	add('<td class="tdFeedCt"><b>Reads</b></td>');
	add('<td class="tdFeedDate"><b>When</b></td>');
	add('</tr>'); indentlevel--;

	for (let i = 0; i < feedsArray.length; i++) {
		let item = feedsArray[i],
			title = item.title;
		const urlFeedPage = `feed?url=${encodeURIComponent(item.url)}`;
		// set title
		if ((title === undefined) || (title === null)) {
			title = 'No title';
		} else {
			title = utils.maxStringLength(title, 40);
		}
		add('<tr>'); indentlevel++;
		add(`<td class="tdFeedTitle"><a href="${urlFeedPage}">${title}</a></td>`);
		add(`<td class="tdFeedCt">${item.ctItems}</td>`);
		add(`<td class="tdFeedDate">${dateString(item.whenLastNewItem)}</td>`);
		add(`<td class="tdFeedCt">${item.ctReads}</td>`);
		add(`<td class="tdFeedDate">${dateString(item.whenLastRead)}</td>`);
		add('</tr>'); indentlevel--;
	}
	add('</table>'); indentlevel--;
	returnThroughTemplate(htmltext, 'Feed List', callback);
}
function viewFeed(urlfeed, callback) {
	initFeed(urlfeed, (feed) => {
		let htmltext = '',
			indentlevel = 0;
		function add(s) {
			htmltext += `${utils.filledString('\t', indentlevel) + s}\n`;
		}
		function viewDate(d) {
			const s = utils.viewDate(d);
			if (s == 'Wednesday, December 31, 1969') {
				return ('');
			}
			return (s);
		}
		function viewDescription() {
			if (feed.feedInfo.description == null) {
				return ('');
			}
			return (feed.feedInfo.description);
		}

		add('<div class="divFeedPageTop">'); indentlevel++;
		add(`<div class="divFeedTitle"><a href="${feed.feedInfo.link}">${feed.feedInfo.title}</a></div>`);
		add(`<div class="divFeedDescription">${viewDescription()}</div>`);
		add(`<div class="divFeedUrl"><a href="${feed.prefs.url}">${feed.prefs.url}</a></div>`);
		add('</div>'); indentlevel--;

		add('<table class="feedTable">'); indentlevel++;
		for (let i = 0; i < feed.history.length; i++) {
			const item = feed.history[i];
			add('<tr>'); indentlevel++;
			add(`<td class="tdFeedTitle"><a href="${item.link}" title="${item.description}">${item.title}</a></td>`);
			add(`<td class="tdFeedDate">${utils.viewDate(item.when)}</td>`);
			add('</tr>'); indentlevel--;
		}
		add('</table>'); indentlevel--;

		feed.stats.whenSubscribed = viewDate(feed.stats.whenSubscribed);
		feed.stats.whenLastRead = viewDate(feed.stats.whenLastRead);
		feed.stats.whenLastNewItem = viewDate(feed.stats.whenLastNewItem);
		feed.stats.mostRecentPubDate = viewDate(feed.stats.mostRecentPubDate);
		feed.stats.whenLastInfoWrite = viewDate(feed.stats.whenLastInfoWrite);
		feed.stats.whenLastReadError = viewDate(feed.stats.whenLastReadError);
		feed.stats.whenLastInfoRead = viewDate(feed.stats.whenLastInfoRead);

		add(`<div class="divFeedStatsJson"><pre>${utils.jsonStringify(feed.stats)}</pre></div>`);

		returnThroughTemplate(htmltext, 'Feed', callback);
	});
}
function configToJsonText() { // remove items whose name contains "password"
	const theCopy = new Object();
	for (const x in config) {
		if (!utils.stringContains(x, 'password')) {
			theCopy[x] = config[x];
		}
	}
	return (utils.jsonStringify(theCopy));
}
function handleHttpRequest(httpRequest, httpResponse) {
	function doHttpReturn(code, type, val) {
		httpResponse.writeHead(code, { 'Content-Type': type });
		httpResponse.end(val.toString());
	}
	function returnHtml(htmltext) {
		httpResponse.writeHead(200, { 'Content-Type': 'text/html' });
		httpResponse.end(htmltext);
	}
	function returnText(theText, flAnyOrigin) {
		function getHeaders(type, flAnyOrigin) {
			const headers = { 'Content-Type': type };
			if (flAnyOrigin) {
				headers['Access-Control-Allow-Origin'] = '*';
			}
			return (headers);
		}
		httpResponse.writeHead(200, getHeaders('text/plain', flAnyOrigin));
		httpResponse.end(theText);
	}
	function return404(msgIfAny) {
		function getHeaders(type) {
			const headers = { 'Content-Type': type };
			return (headers);
		}
		httpResponse.writeHead(404, getHeaders('text/plain'));
		if (msgIfAny !== undefined) {
			httpResponse.end(msgIfAny);
		} else {
			httpResponse.end('Not found');
		}
	}
	function returnRedirect(url, code) {
		if (code === undefined) {
			code = 302;
		}
		httpResponse.writeHead(code, { location: url, 'Content-Type': 'text/plain' });
		httpResponse.end(`${code} REDIRECT`);
	}

	function returnError(message, code) {
		if (code === undefined) {
			code = 500;
		}
		httpResponse.writeHead(code, { location: url, 'Content-Type': 'text/plain' });
		httpResponse.end(message);
	}

	function stringMustBeFilename(s, callback) {
		if (utils.stringContains(s, '/')) {
			returnError('Illegal file name.', 403);
		} else {
			callback();
		}
	}
	function writeHead(type) {
		if (type == undefined) {
			type = 'text/plain';
		}
		httpResponse.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
	}
	function respondWithObject(obj) {
		writeHead('application/json');
		httpResponse.end(utils.jsonStringify(obj));
	}
	function returnServerHomePage() {
		request(config.urlServerHomePageSource, (error, response, templatetext) => {
			if (!error && response.statusCode == 200) {
				const pagetable = {
					config: configToJsonText(),
					version: myVersion,
				};
				const pagetext = utils.multipleReplaceAll(templatetext, pagetable, false, '[%', '%]');
				returnHtml(pagetext);
			}
		});
	}
	function handleRequestLocally() {
		switch (httpRequest.method) {
		case 'GET':
			switch (lowerpath) {
			case '/': // 7/4/15 by DW
				returnServerHomePage();
				break;
			case '/version':
				returnText(myVersion);
				break;
			case '/now':
				returnText(now.toString());
				break;
			case '/stats': case '/serverdata':
				returnText(getServerStatsJson(), true); // 11/16/16 by DW -- set flAnyOrigin boolean
				break;
			case '/feedstats':
				returnText(utils.jsonStringify(feedsArray, true));
				break;
			case '/buildallrivers':
				if (config.enabled) {
					buildAllRivers();
					returnText('Your rivers are building sir or madam.');
				} else {
					returnText("Can't build the rivers because config.enabled is false.");
				}
				break;
			case '/loadlists':
				loadListsFromFolder();
				returnText("We're reading the lists, right now, as we speak.");
			case '/dashboard':
				request(config.urlDashboardSource, (error, response, htmltext) => {
					if (!error && response.statusCode == 200) {
						returnHtml(htmltext);
					}
				});
				break;
			case '/ping':
				var url = parsedUrl.query.url;
				if (url === undefined) {
					returnText("Ping received, but no url param was specified, so we couldn't do anything with it. Sorry.");
				} else if (findInFeedsArray(url) === undefined) {
					returnText("Ping received, but we're not following this feed. Sorry.");
				} else {
					returnText('Ping received, will read asap.');
					readFeedIfSubscribed(url, () => {
						myConsoleLog('Feed read.');
					});
				}
				break;
			case '/getlistnames': // 11/11/14 by DW
				httpResponse.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
				httpResponse.end(utils.jsonStringify(serverStats.listNames));
				break;
			case '/getalllists':
				getAllLists((theLists) => {
					returnText(utils.jsonStringify(theLists), true);
				});
				break;
			case '/getonefeed':
				getOneFeed(parsedUrl.query.url, (theFeed) => {
					returnText(utils.jsonStringify(theFeed), true);
				});
				break;
			case '/getfeedriver': // 6/29/17 by DW
				getFeedRiverForServer(parsedUrl.query.url, (jstruct) => {
					returnText(utils.jsonStringify(jstruct), true);
				});
				break;
			case '/getoneriver': // 11/28/14 by DW
				getOneRiver(parsedUrl.query.fname, (s) => {
					returnText(s, true);
				});
				break;
			case '/getonelist': // 2/3/16 by DW
				var fname = parsedUrl.query.fname;
				stringMustBeFilename(fname, () => {
					getOneList(fname, (s) => {
						if (s === undefined) {
							return404();
						} else {
							returnText(s, true);
						}
					});
				});
				break;
			case '/getfeedmeta': // 12/1/14 by DW -- for the list editor, just get the metadata about the feed
				httpResponse.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
				getFeedMetadata(parsedUrl.query.url, (data) => {
					if (data == undefined) {
						httpResponse.end('');
					} else {
						httpResponse.end(utils.jsonStringify(data));
					}
				});
				break;
			case '/readfile': // 12/1/14 by DW
				httpResponse.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
				httpReadUrl(parsedUrl.query.url, (s) => { // xxx
					if (s == undefined) {
						httpResponse.end('');
					} else {
						httpResponse.end(s);
					}
				});
				break;
			case '/getprefs': // 12/1/14 by DW
				respondWithObject(config);
				break;
			case '/feedupdated': // 6/4/15 by DW
				var challenge = parsedUrl.query.challenge;
				myConsoleLog(`/feedupdated: challenge == ${challenge}`);
				httpResponse.writeHead(200, { 'Content-Type': 'text/plain' });
				httpResponse.end(challenge);
				break;
			case '/renewfeed': // 6/14/17 by DW
				var url = parsedUrl.query.url;
				renewThisFeedNow(parsedUrl.query.url, (message) => {
					returnText(message);
				});
				break;
			case '/favicon.ico': // 7/19/15 by DW
				returnRedirect(config.urlFavicon);
				break;

			case '/feedlist': // 1/27/16 by DW
				viewFeedList((s) => {
					returnHtml(s);
				});
				break;
			case '/feed': // 1/27/16 by DW
				var url = parsedUrl.query.url;
				viewFeed(url, (s) => {
					returnHtml(s);
				});
				break;
			case '/test': // 1/28/16 by DW
				var theFeed = findInFeedsArray('http://scripting.com/rss.xml');
				returnText(utils.jsonStringify(theFeed));


				break;

			default: // 404 not found
				httpResponse.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
				httpResponse.end(`"${lowerpath}" is not one of the endpoints defined by this server.`);
			}
			break;
		case 'POST': // 12/2/14 by DW
			var body = '';
			httpRequest.on('data', (data) => {
				body += data;
			});
			httpRequest.on('end', () => {
				let flPostAllowed = false;

				// set flPostAllowed -- 12/4/14 by DW
				if (flLocalRequest) {
					flPostAllowed = true;
				} else if (lowerpath == '/feedupdated') {
					flPostAllowed = true;
				} else if (config.remotePassword.length > 0) { // must have password set
					flPostAllowed = (parsedUrl.query.password === config.remotePassword);
				}
				if (flPostAllowed) {
					myConsoleLog(`POST body length: ${body.length}`);
					switch (lowerpath) {
					case '/savelist':
						var listname = parsedUrl.query.listname;
						stringMustBeFilename(listname, () => {
							saveSubscriptionList(listname, body);
							returnText('', true);
						});
						break;
					case '/feedupdated': // 6/4/15 by DW
						var postbody = qs.parse(body);
						rssCloudFeedUpdated(postbody.url);
						httpResponse.writeHead(200, { 'Content-Type': 'text/plain' });
						httpResponse.end('Thanks for the update! :-)');
						break;
					default: // 404 not found
						httpResponse.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
						httpResponse.end(`"${lowerpath}" is not one of the endpoints defined by this server.`);
					}
				} else {
					httpResponse.writeHead(403, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
					httpResponse.end('This feature can only be accessed locally.');
				}
			});
			break;
		}
	}
	try {
		var parsedUrl = urlpack.parse(httpRequest.url, true),
			now = new Date(),
			startTime = now;
		var lowerpath = parsedUrl.pathname.toLowerCase(),
			host,
			port = 80,
			flLocalRequest = false;

		// set host, port, flLocalRequest
		host = httpRequest.headers.host;
		if (utils.stringContains(host, ':')) {
			port = utils.stringNthField(host, ':', 2);
			host = utils.stringNthField(host, ':', 1);
		}
		flLocalRequest = utils.beginsWith(host, 'localhost');
		// show the request on the console
		let localstring = '';
		if (flLocalRequest) {
			localstring = '* ';
		}
		myConsoleLog(`${localstring + httpRequest.method} ${host}:${port} ${lowerpath}`);

		// stats
		serverStats.ctHits++;
		serverStats.ctHitsToday++;
		serverStats.ctHitsThisRun++;

		if (config.handleHttpRequestCallback !== undefined) {
			const myRequest = { // bundle things up for the callback
				method: httpRequest.method,
				path: parsedUrl.pathname,
				lowerpath,
				params: {},
				host,
				lowerhost: host.toLowerCase(),
				port,
				referrer: undefined,
				flLocalRequest,
				client: httpRequest.connection.remoteAddress,
				now: new Date(),
				sysRequest: httpRequest,
				sysResponse: httpResponse,
				httpReturn: doHttpReturn,
			};
			for (const x in parsedUrl.query) {
				myRequest.params[x] = parsedUrl.query[x];
			}
			config.handleHttpRequestCallback(myRequest, (flConsumed) => {
				if (!flConsumed) {
					handleRequestLocally();
				}
			});
		} else {
			handleRequestLocally();
		}
	} catch (tryError) {
		httpResponse.writeHead(503, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
		httpResponse.end(tryError.message);
	}
}
function startHttpServer() {
	if (config.flHttpEnabled) {
		try {
			http.createServer(handleHttpRequest).listen(config.httpPort);
		} catch (err) {
			myConsoleLog(`startHttpServer: err.message == ${err.message}`);
		}
	}
}
// background processes
function everyQuarterSecond() {
	if (config.enabled) {
		findNextFeedToRead((urlFeed) => {
			readFeed(urlFeed, () => {
			});
		});
	}
}
function everySecond() {
	function checkStuff() {
		const now = new Date();
		if (!flEveryMinuteScheduled) {
			if (now.getSeconds() == 0) {
				setInterval(everyMinute, 60000);
				everyMinute(); // do one right now
				flEveryMinuteScheduled = true;
			}
		}
		if (config.enabled) {
			if (config.flMaintainCalendarStructure) {
				if (flRiverChanged) {
					saveTodaysRiver();
					flRiverChanged = false;
				}
			}
			if (flStatsChanged) {
				saveStats();
				flStatsChanged = false;
				if (config.statsChangedCallback !== undefined) { // 3/25/17 by DW
					config.statsChangedCallback(getServerStatsJson());
				}
			}
			if (flFeedsArrayChanged) {
				saveFeedsArray();
				flFeedsArrayChanged = false;
			}
			if (flFeedsInListsChanged) {
				flFeedsInListsChanged = false;
				saveFeedsInLists();
			}
			if (flFileWriteQueueChanged) {
				flFileWriteQueueChanged = false;
				checkFileWriteQueue();
			}
			checkPodcastQueue(); // 4/18/17 by DW
		}
		if (config.everySecondCallback !== undefined) { // 6/20/17 by DW
			config.everySecondCallback();
		}
	}
	if (config.flWatchAppDateChange) {
		utils.getFileModDate(config.fnameApp, (theModDate) => {
			if (theModDate != origAppModDate) {
				myConsoleLog(`everySecond: ${config.fnameApp} has been updated. ${myProductName} is quitting now.`);
				process.exit(0);
			} else {
				checkStuff();
			}
		});
	} else {
		checkStuff();
	}
}
function everyFiveSeconds() {
	if (config.enabled) {
		renewNextSubscription();
		writeLocalStorageIfChanged();
		saveChangedRiverStructs();
		saveChangedFeedRivers(); // 6/29/17 by DW
		if (config.flBuildEveryFiveSeconds) { // 3/29/17 by DW
			buildChangedRivers();
		}
	}
}
function everyMinute() {
	const now = new Date();
	function doConsoleMessage() {
		let ctsockets = countOpenSockets(),
			portmsg = '';
		if (ctsockets == 1) {
			ctsockets = `${ctsockets} open socket`;
		} else {
			ctsockets = `${ctsockets} open sockets`;
		}

		if (config.flHttpEnabled) {
			portmsg = `, port: ${config.httpPort}`;
		}

		myConsoleLog(`\n${myProductName} v${myVersion}: ${now.toLocaleTimeString()}, ${feedsArray.length} feeds, ${serverStats.ctFeedReadsThisRun} reads, ${serverStats.ctStoriesAddedThisRun} stories, ${ctsockets}${portmsg}.`);
	}

	if (config.enabled) {
		buildChangedRivers(() => {
			doConsoleMessage();
			loadListsFromFolder();
			checkRiverRollover();
			tossOldFeedRivers(); // 6/29/17 by DW
			// check for hour rollover
			const thisHour = now.getHours();
			if (thisHour != lastEveryMinuteHour) {
				serverStats.ctFeedReadsLastHour = 0;
				flStatsChanged = true;
				lastEveryMinuteHour = thisHour;
			}
		});
	} else {
		doConsoleMessage();
	}

	if (config.everyMinuteCallback !== undefined) { // 6/20/17 by DW
		config.everyMinuteCallback();
	}
}

function init(userConfig, callback) {
	const now = new Date();
	for (x in userConfig) {
		config[x] = userConfig[x];
	}

	loadTodaysRiver(() => {
		readStats(config.statsFilePath, serverStats, () => {
			serverStats.aggregator = `${myProductName} v${myVersion}`;
			serverStats.whenLastStart = now;
			serverStats.ctStarts++;
			serverStats.ctFeedReadsThisRun = 0;
			serverStats.ctStoriesAddedThisRun = 0;
			serverStats.ctHitsThisRun = 0;
			serverStats.ctFeedReadsLastHour = 0;

			if (serverStats.listModDates !== undefined) {
				delete serverStats.listModDates;
			}
			if (serverStats.ctCloudRenews !== undefined) {
				delete serverStats.ctCloudRenews;
			}
			if (serverStats.ctReadsSkipped !== undefined) {
				delete serverStats.ctReadsSkipped;
			}
			if (serverStats.ctActiveThreads !== undefined) {
				delete serverStats.ctActiveThreads;
			}

			flStatsChanged = true;

			readStats(fnameFeedsStats, feedsArray, () => {
				loadListsFromFolder(() => {
					loadLocalStorage(() => {
						utils.getFileModDate(config.fnameApp, (theDate) => { // set origAppModDate
							origAppModDate = theDate;

							let portmsg = '';
							if (config.flHttpEnabled) {
								portmsg = ` running on port ${config.httpPort}`;
							}

							myConsoleLog(`\n${configToJsonText()}`);
							myConsoleLog(`\n${myProductName} v${myVersion}${portmsg}.\n`);

							setInterval(everyQuarterSecond, 250);
							setInterval(everySecond, 1000);
							setInterval(everyFiveSeconds, 5000);
							startHttpServer();
							startWebSocketServer();
							if (callback !== undefined) {
								callback();
							}
						});
					});
				});
			});
		});
	});
}
