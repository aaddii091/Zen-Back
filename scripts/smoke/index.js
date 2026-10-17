// Smoke-test entry point. Add each new feature's suite to SUITES below.
//
//   docker run -d --name zen-test-mongo -p 27018:27017 mongo:7
//   npm run smoke

const { boot, shutdown, report } = require('./harness');

const SUITES = [
  './01-school-admin',
  './02-classroom-counsellor',
  './03-escalation',
  './04-referral-audit',
  './05-after-hours',
  './06-counsellor-notes',
];

(async () => {
  let ok = false;
  try {
    const { baseUrl } = await boot();
    console.log(`\n  smoke suite — app on ${baseUrl}, db ${process.env.DATABASE}`);

    for (const suitePath of SUITES) {
      await require(suitePath)();
    }

    ok = report();
  } catch (err) {
    console.error('\n  smoke run crashed:\n', err);
    ok = false;
  } finally {
    await shutdown();
  }

  process.exit(ok ? 0 : 1);
})();
