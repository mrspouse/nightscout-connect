const cron = require('node-cron');
const glookoTest = require('./glooko-test');

// Schedule tasks to be run on the server.
cron.schedule('20 * * * *', function() {
  console.log('running...');
  glookoTest();
});