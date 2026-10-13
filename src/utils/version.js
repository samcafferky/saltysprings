'use strict';

// Works out which build/season the client is from its User-Agent, e.g.
// "Fortnite/++Fortnite+Release-4.5-CL-4166199 Windows/10.0.17134.1.768.64bit"
function getVersionInfo(userAgent = '', defaultSeason = 2) {
  const info = { season: defaultSeason, build: defaultSeason, cl: '0', lobby: `LobbySeason${defaultSeason}` };

  const clMatch = userAgent.match(/-CL-(\d+)/);
  if (clMatch) info.cl = clMatch[1];

  const releaseMatch = userAgent.match(/Release-(\d+)\.(\d+)/);
  if (releaseMatch) {
    const major = Number(releaseMatch[1]);
    const minor = Number(releaseMatch[2]);
    info.build = Number(`${major}.${minor}`);
    // Season 1 ran on 1.x builds before 1.11; 1.11 started Season 2.
    info.season = major === 1 ? (minor >= 11 ? 2 : 1) : major;
  } else if (/Cert/i.test(userAgent)) {
    info.season = 1;
    info.build = 1;
  } else if (clMatch) {
    // Very old builds only report a changelist.
    const cl = Number(clMatch[1]);
    if (cl < 3724489) {
      info.season = 1;
      info.build = 1;
    }
  }

  info.lobby = `LobbySeason${info.season}`;
  return info;
}

module.exports = { getVersionInfo };
