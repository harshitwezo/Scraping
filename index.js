// index.js
const express   = require('express');
const http      = require('http');
const socketIo  = require('socket.io');
const puppeteer = require('puppeteer');

const PORT           = process.env.PORT || 3000;
const FULL_SCRAPE_MS = 30 * 1000; // for new events/structure
const DYNAMIC_POLL_MS = 1 * 1000; // poll odds & moreBets every 1s
const INPLAY_URL     = 'https://sports.williamhill.com/betting/en-gb/in-play/football';

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server);

app.use(express.static('public'));

let latestData = [];

/** Full initial scrape */
async function fullScrape(page) {
  try {
    const data = await page.$$eval('.event', events =>
      events.map(ev => {
        const teams = Array.from(
          ev.querySelectorAll('.btmarket__link-name--2-rows span')
        ).map(sp => sp.textContent.trim());

        const oddsEls = ev.querySelectorAll('.btmarket__actions .betbutton__odds');
        const homeOdd  = oddsEls[0]?.textContent.trim() || '';
        const drawOdd  = oddsEls[1]?.textContent.trim() || '';
        const awayOdd  = oddsEls[2]?.textContent.trim() || '';

        const time = ev
          .querySelector('.btmarket__boundary label.wh-label')
          ?.textContent.trim() || '';

        const homeScore = ev.querySelector('.btmarket__livescore-item.team-a')
          ?.textContent.trim() || '';
        const awayScore = ev.querySelector('.btmarket__livescore-item.team-b')
          ?.textContent.trim() || '';
        const score = homeScore && awayScore ? `${homeScore}–${awayScore}` : '';

        const moreEl  = ev.querySelector('a.btmarket__more-bets-counter');
        const moreBets = moreEl ? moreEl.textContent.trim() : '';

        return { teams, homeOdd, drawOdd, awayOdd, time, score, moreBets };
      })
    );

    latestData = data;
    const payload = { data: latestData, ts: Date.now(), type: null };
    io.emit('liveData', payload);
    console.log(`✔️ Full scrape: ${data.length} events`);
  } catch (e) {
    console.error('fullScrape error:', e.message);
  }
}

/** Poll odds + moreBets every second */
async function dynamicPoll(page) {
  try {
    const snapshot = await page.$$eval('.event', evs =>
      evs.map(ev => {
        const oddsEls = ev.querySelectorAll('.btmarket__actions .betbutton__odds');
        const homeOdd = oddsEls[0]?.textContent.trim() || '';
        const drawOdd = oddsEls[1]?.textContent.trim() || '';
        const awayOdd = oddsEls[2]?.textContent.trim() || '';
        const moreEl  = ev.querySelector('a.btmarket__more-bets-counter');
        const moreBets = moreEl ? moreEl.textContent.trim() : '';
        return { homeOdd, drawOdd, awayOdd, moreBets };
      })
    );

    snapshot.forEach((s, idx) => {
      const evt = latestData[idx];
      if (!evt) return;

      let changed = false, field = null;

      if (evt.homeOdd !== s.homeOdd)   { evt.homeOdd = s.homeOdd;   changed = true; field = 'homeOdd'; }
      else if (evt.drawOdd !== s.drawOdd)   { evt.drawOdd = s.drawOdd;   changed = true; field = 'drawOdd'; }
      else if (evt.awayOdd !== s.awayOdd)   { evt.awayOdd = s.awayOdd;   changed = true; field = 'awayOdd'; }
      else if (evt.moreBets !== s.moreBets) { evt.moreBets = s.moreBets; changed = true; field = 'moreBets'; }

      if (changed) {
        const payload = { data: latestData, ts: Date.now(), idx, type: field };
        io.emit('liveData', payload);
        console.log(`🔄 ${field} update idx=${idx}`);
      }
    });
  } catch (e) {
    console.error('dynamicPoll error:', e.message);
  }
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: puppeteer.executablePath(),
    args: ['--no-sandbox','--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.goto(INPLAY_URL, { waitUntil: 'domcontentloaded' });

  // Instant time/score updates via MutationObserver
  await page.exposeFunction('onDomUpdate', ({ idx, time, score }) => {
    const evt = latestData[idx];
    if (!evt) return;
    let changed = false;
    if (evt.score !== score) { evt.score = score; changed = true; }
    if (evt.time  !== time)  { evt.time  = time;  /* no blink on time */ }
    if (changed) {
      const payload = { data: latestData, ts: Date.now(), idx, type: 'score' };
      io.emit('liveData', payload);
    }
  });

  await page.evaluate(() => {
    document.querySelectorAll('.event').forEach((ev, idx) => {
      const timeEl = ev.querySelector('.btmarket__boundary label.wh-label');
      const scoreA = ev.querySelector('.btmarket__livescore-item.team-a');
      const scoreB = ev.querySelector('.btmarket__livescore-item.team-b');
      const obs    = new MutationObserver(() => {
        window.onDomUpdate({
          idx,
          time: timeEl?.textContent.trim() || '',
          score: scoreA && scoreB
            ? `${scoreA.textContent.trim()}–${scoreB.textContent.trim()}`
            : ''
        });
      });
      if (timeEl) obs.observe(timeEl,   { childList:true, characterData:true, subtree:true });
      if (scoreA) obs.observe(scoreA,   { childList:true, characterData:true, subtree:true });
      if (scoreB) obs.observe(scoreB,   { childList:true, characterData:true, subtree:true });
    });
  });

  // Kickoff
  await fullScrape(page);
  setInterval(() => fullScrape(page), FULL_SCRAPE_MS);
  setInterval(() => dynamicPoll(page), DYNAMIC_POLL_MS);

  io.on('connection', sock =>
    sock.emit('liveData', { data: latestData, ts: Date.now(), type: null })
  );

  server.listen(PORT, () => console.log(`🚀 Listening on http://localhost:${PORT}`));
})();
