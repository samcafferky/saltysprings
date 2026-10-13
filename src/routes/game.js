'use strict';

const express = require('express');
const { requireAuth, readBearer } = require('../middleware/auth');
const { getVersionInfo } = require('../utils/version');
const { nextUtcMidnight } = require('../services/catalog');
const { EpicError, errors } = require('../utils/errors');

const FAR_FUTURE = '9999-12-31T23:59:59.999Z';

function lightswitchStatus(banned) {
  return {
    serviceInstanceId: 'fortnite',
    status: 'UP',
    message: 'Fortnite is online',
    maintenanceUri: null,
    overrideCatalogIds: ['a7f138b2e51945ffbfdacc1af0541053'],
    allowedActions: ['PLAY', 'DOWNLOAD'],
    banned,
    launcherInfoDTO: { appName: 'Fortnite', catalogItemId: '4fe75bbc5a674f4f9b356b5c90567da5', namespace: 'fn' },
  };
}

// Season 10's lobby background is called "seasonx"; the rest are "seasonN".
function backgroundStage(season) {
  return season === 10 ? 'seasonx' : `season${season}`;
}

module.exports = function gameRoutes(services, config) {
  const router = express.Router();
  const auth = requireAuth(services);
  const version = (req) => getVersionInfo(req.headers['user-agent'], config.game.defaultSeason);

  // Tells the launcher/game whether the player can play (and if they're banned).
  function isBanned(req) {
    const token = readBearer(req);
    const found = token && services.tokens.find(token, ['access']);
    const account = found && services.accounts.findById(found.accountId);
    return Boolean(account && account.banned);
  }
  router.get('/lightswitch/api/service/Fortnite/status', (req, res) => res.json(lightswitchStatus(isBanned(req))));
  router.get('/lightswitch/api/service/bulk/status', (req, res) => res.json([lightswitchStatus(isBanned(req))]));

  router.get(['/fortnite/api/version', '/fortnite/api/v2/version'], (req, res) =>
    res.json({ app: 'fortnite', serverDate: new Date().toISOString(), overridePropertiesVersion: 'unknown', cln: '0', build: '0', moduleName: 'Fortnite-Core', buildDate: '2018-01-01T00:00:00.000Z', version: '1.0.0', branch: 'Release', modules: {} }),
  );
  router.get(['/fortnite/api/versioncheck', '/fortnite/api/versioncheck/*splat', '/fortnite/api/v2/versioncheck/*splat'], (req, res) =>
    res.json({ type: 'NO_UPDATE' }),
  );

  // The calendar decides which season the lobby shows and when the shop resets.
  router.get('/fortnite/api/calendar/v1/timeline', (req, res) => {
    const { season } = version(req);
    const now = new Date().toISOString();
    const shopReset = nextUtcMidnight();
    const activeEvents = [
      { eventType: `EventFlag.Season${season}`, activeUntil: FAR_FUTURE, activeSince: '2020-01-01T00:00:00.000Z' },
      { eventType: `EventFlag.LobbySeason${season}`, activeUntil: FAR_FUTURE, activeSince: '2020-01-01T00:00:00.000Z' },
    ];
    res.json({
      channels: {
        'client-matchmaking': { states: [], cacheExpire: FAR_FUTURE },
        'client-events': {
          states: [
            {
              validFrom: '2020-01-01T00:00:00.000Z',
              activeEvents,
              state: {
                activeStorefronts: [],
                eventNamedWeights: {},
                seasonNumber: season,
                seasonTemplateId: `AthenaSeason:athenaseason${season}`,
                matchXpBonusPoints: 0,
                seasonBegin: '2020-01-01T00:00:00Z',
                seasonEnd: FAR_FUTURE,
                seasonDisplayedEnd: FAR_FUTURE,
                weeklyStoreEnd: shopReset,
                stwEventStoreEnd: FAR_FUTURE,
                stwWeeklyStoreEnd: FAR_FUTURE,
                sectionStoreEnds: { Featured: shopReset },
                dailyStoreEnd: shopReset,
              },
            },
          ],
          cacheExpire: FAR_FUTURE,
        },
      },
      eventsTimeOffsetHrs: 0,
      cacheIntervalMins: 10,
      currentTime: now,
    });
  });

  // Lobby news, emergency notices and the lobby background.
  router.get('/content/api/pages/fortnite-game', (req, res) => {
    const { season } = version(req);
    const now = new Date().toISOString();
    const page = (title, extra) => ({ _title: title, _activeDate: '2020-01-01T00:00:00.000Z', lastModified: now, _locale: 'en-US', ...extra });
    const news = config.game.news || [];
    const messages = news.map((n, i) => ({
      hidden: false,
      _type: 'CommonUI Simple Message Base',
      adspace: '',
      title: n.title,
      body: n.body,
      image: n.image || '',
      spotlight: false,
      messagetype: 'normal',
      id: `ogfn-news-${i}`,
    }));
    const motds = news.map((n, i) => ({
      entryType: 'Text',
      image: n.image || '',
      tileImage: n.image || '',
      hidden: false,
      videoMute: false,
      tabTitleOverride: n.title,
      _type: 'CommonUI Simple Message MOTD',
      title: n.title,
      body: n.body,
      videoLoop: false,
      videoStreamingEnabled: false,
      sortingPriority: news.length - i,
      id: `ogfn-motd-${i}`,
      videoAutoplay: false,
      videoFullscreen: false,
      spotlight: false,
    }));
    res.json({
      'jcr:isCheckedOut': true,
      _title: 'Fortnite Game',
      'jcr:baseVersion': 'a7ca237317f1e74e4b8154-226a-4450-a44f-a56cf2ab0b1a',
      _activeDate: '2020-01-01T00:00:00.000Z',
      lastModified: now,
      _locale: 'en-US',
      battleroyalenews: page('battleroyalenews', {
        news: { _type: 'Battle Royale News', motds, messages },
        header: '',
        style: 'None',
        _noIndex: false,
        alwaysShow: false,
      }),
      athenamessage: page('athenamessage', { overrideablemessage: { _type: 'CommonUI Simple Message', message: messages[0] || {} } }),
      emergencynotice: page('emergencynotice', { news: { platform_messages: [], _type: 'Battle Royale News', messages: [] } }),
      emergencynoticev2: page('emergencynoticev2', { emergencynotices: { _type: 'Emergency Notices', emergencynotices: [] } }),
      dynamicbackgrounds: page('dynamicbackgrounds', {
        backgrounds: {
          backgrounds: [
            { stage: backgroundStage(season), _type: 'DynamicBackground', key: 'lobby' },
            { stage: backgroundStage(season), _type: 'DynamicBackground', key: 'vault' },
          ],
          _type: 'DynamicBackgroundList',
        },
        _noIndex: false,
      }),
      shopSections: page('shop-sections', {
        sectionList: {
          _type: 'ShopSectionList',
          sections: [
            { bSortOffersByOwnership: false, bShowIneligibleOffersIfGiftable: false, bEnableToastNotification: true, background: {}, _type: 'ShopSection', landingPriority: 70, bHidden: false, sectionId: 'Featured', bShowTimer: true, sectionDisplayName: 'Featured', bShowIneligibleOffers: true },
            { bSortOffersByOwnership: false, bShowIneligibleOffersIfGiftable: false, bEnableToastNotification: true, background: {}, _type: 'ShopSection', landingPriority: 69, bHidden: false, sectionId: 'Daily', bShowTimer: true, sectionDisplayName: 'Daily', bShowIneligibleOffers: true },
          ],
        },
      }),
      playlistinformation: page('playlistinformation', {
        frontend_matchmaking_header_style: 'None',
        _noIndex: false,
        playlist_info: { _type: 'Playlist Information', playlists: [] },
      }),
    });
  });
  router.get('/content/api/pages/*splat', (req, res) => res.json({}));

  router.get('/fortnite/api/storefront/v2/catalog', auth, (req, res) => res.json(services.catalog.catalog()));
  router.get('/fortnite/api/storefront/v2/keychain', auth, (req, res) => res.json([]));
  router.get('/fortnite/api/storefront/v2/gift/check_eligibility/recipient/:recipientId/offer/:offerId', auth, (req, res, next) =>
    next(new EpicError('errors.com.epicgames.fortnite.gifting_disabled', 'Gifting is disabled on this server.', 28001, 403)),
  );
  router.get('/catalog/api/shared/bulk/offers', (req, res) => res.json({}));
  router.get('/fortnite/api/receipts/v1/account/:accountId/receipts', auth, (req, res) => res.json([]));
  router.get('/fortnite/api/game/v2/enabled_features', auth, (req, res) => res.json([]));
  router.post('/fortnite/api/game/v2/tryPlayOnPlatform/account/:accountId', auth, (req, res) => res.type('text/plain').send('true'));
  router.post('/fortnite/api/game/v2/grant_access/:accountId', auth, (req, res) => res.status(204).end());
  router.get('/fortnite/api/game/v2/world/info', auth, (req, res) => res.json({}));
  router.get('/fortnite/api/game/v2/br-inventory/account/:accountId', auth, (req, res) => res.json({ stash: { globalcash: 0 } }));
  router.post('/fortnite/api/game/v2/profileToken/verify/:accountId', auth, (req, res) => res.status(204).end());
  router.get('/fortnite/api/game/v2/privacy/account/:accountId', auth, (req, res) =>
    res.json({ accountId: req.params.accountId, optOutOfPublicLeaderboards: false }),
  );
  router.post('/fortnite/api/game/v2/privacy/account/:accountId', auth, (req, res) =>
    res.json({ accountId: req.params.accountId, optOutOfPublicLeaderboards: Boolean((req.body || {}).optOutOfPublicLeaderboards) }),
  );
  router.get('/fortnite/api/game/v2/events/tournamentandhistory/:accountId/:region/:platform', auth, (req, res) => res.json({}));

  // Stats & leaderboards are kept empty.
  const emptyStats = (req, res) =>
    res.json({ startTime: 0, endTime: 9223372036854775807, stats: {}, accountId: req.params.accountId });
  router.get('/fortnite/api/statsv2/account/:accountId', auth, emptyStats);
  router.get('/statsproxy/api/statsv2/account/:accountId', auth, emptyStats);
  router.get('/fortnite/api/stats/accountId/:accountId/bulk/window/:window', auth, (req, res) => res.json([]));
  router.post('/fortnite/api/leaderboards/type/:type/stat/:stat/window/:window', auth, (req, res) =>
    res.json({ statName: req.params.stat, statWindow: req.params.window, entries: [] }),
  );
  router.post('/statsproxy/api/statsv2/query', auth, (req, res) => res.json([]));

  // Tournaments (Arena / events tab).
  router.get('/api/v1/events/Fortnite/download/:accountId', auth, (req, res) =>
    res.json({
      player: { gameId: 'Fortnite', accountId: req.params.accountId, tokens: [], teams: {}, pendingPayouts: [], pendingPenalties: {}, persistentScores: {}, groupIdentity: {} },
      events: [],
      templates: [],
      scores: [],
    }),
  );
  router.get('/api/v1/players/Fortnite/tokens', auth, (req, res) => res.json({ accounts: [] }));

  router.get('/waitingroom/api/waitingroom', (req, res) => res.status(204).end());
  router.post(['/datarouter/api/v1/public/data', '/telemetry/data/*splat'], (req, res) => res.status(204).end());
  router.post('/fortnite/api/feedback/*splat', (req, res) => res.json({}));
  router.get('/socialban/api/public/v1/:accountId', (req, res) => res.json({ bans: [], warnings: [] }));
  router.get('/eulatracking/api/shared/agreements/fn*splat', (req, res) => res.json({}));
  router.get('/eulatracking/api/public/agreements/fn/account/:accountId', (req, res) => res.status(204).end());
  router.get('/fortnite/api/game/v2/twitch/:accountId', (req, res) => res.json({}));
  router.get('/launcher/api/public/distributionpoints/', (req, res) =>
    res.json({ distributions: ['https://download.epicgames.com/', 'https://download2.epicgames.com/', 'https://download3.epicgames.com/', 'https://download4.epicgames.com/', 'https://epicgames-download1.akamaized.net/'] }),
  );
  router.get('/hotconfigs/v2/livefn.json', (req, res) =>
    res.json({ HotConfigData: [{ AppId: 'livefn', EpicApp: 'FortniteLivefn', Modules: [] }] }),
  );
  router.get('/region', (req, res) =>
    res.json({ continent: { code: 'NA', geoname_id: 6255149, names: { en: 'North America' } }, country: { geoname_id: 6252001, is_in_european_union: false, iso_code: 'US', names: { en: 'United States' } }, subdivisions: [] }),
  );
  router.post('/api/v1/assets/Fortnite/:version/:netcl', (req, res) =>
    res.json({ FortCreativeDiscoverySurface: { meta: { promotion: 0 }, assets: {} } }),
  );
  router.get('/api/v1/user/setting', (req, res) => res.json([]));
  router.post('/api/v1/user/setting', (req, res) => res.json([]));
  router.get('/presence/api/v1/*splat', (req, res) => res.json([]));
  router.all('/presence/api/v1/*splat', (req, res) => res.status(204).end());
  router.get('/fortnite/api/game/v2/creative/*splat', (req, res) => res.json({ results: [], hasMore: false }));
  router.get('/content-controls/:accountId', (req, res) => res.json({ data: { ageGate: 0, controlsEnabled: false, maxEpicProfilePrivacy: 'none' } }));
  router.get('/content-controls/:accountId/rules/namespaces/fn', (req, res) => res.json({}));

  // Newer seasons (roughly 11+) ask for these while loading the lobby.
  router.get('/fortnite/api/discovery/accessToken/:branch', auth, (req, res) =>
    res.json({ branchName: req.params.branch, appId: 'Fortnite', token: services.ids.hexId() }),
  );
  router.post(['/api/v1/discovery/surface/:surface', '/fortnite/api/game/v2/creative/discovery/surface/:accountId'], (req, res) =>
    res.json({ Panels: [{ PanelName: 'Homebar', Pages: [{ results: [], hasMore: false }] }], TestCohorts: ['testing'], ModeSets: {} }),
  );
  router.get('/links/api/fn/mnemonic/:code', (req, res, next) => next(errors.notFound()));
  router.post('/fortnite/api/storeaccess/v1/request_access/:accountId', auth, (req, res) => res.status(204).end());
  router.post('/fortnite/api/game/v2/events/v2/setSubgroup/:accountId', auth, (req, res) => res.status(204).end());
  router.get('/fortnite/api/game/v2/friendcodes/:accountId/:type', auth, (req, res) => res.json([]));
  router.get('/affiliate/api/public/affiliates/slug/:slug', (req, res, next) => next(errors.notFound()));
  router.get('/api/v1/lfg/Fortnite/users/:accountId/settings', auth, (req, res) => res.json({ status: 'PUBLIC' }));
  router.get('/fortnite/api/game/v2/homebase/allowed-name-chars', (req, res) =>
    res.json({ ranges: [48, 57, 65, 90, 97, 122], multiRanges: [], characters: [] }),
  );

  return router;
};
