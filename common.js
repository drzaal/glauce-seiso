'use strict';

module.exports.getProtocolFromPort = exports.getProtocolFromPort = getProtocolFromPort;
module.exports.sleepUntil = exports.sleepUntil = sleepUntil;

function getProtocolFromPort(port) {
  var protocol = null;
  if (port % 10 == 3) {
    protocol = "https";
  }
  else if (port % 100 == 80) {
    protocol = "http";
  }
  else if (port == 22) {
    protocol = "ssh";
  }
  else if (port == 24 || port == 25) {
    protocol = "ftp";
  }
  else if (port == 21) {
    protocol = "smtp";
  }

  return protocol;
}

/**
 * Sleep until a given condition is met, optionally with a timeout
 **/
 var minimumSleepInterval = 25, defaultSleepInterval = 100, defaultMaxWaitTime = 20000;

function sleepUntil(test, callback, interval, maxWaitTime) {
  // Set the interval, if not set or invalid
  if (typeof interval === 'undefined' || interval === null) {
    interval = defaultSleepInterval;
  }
  else if (interval < minimumSleepInterval) {
    interval = minimumSleepInterval;
  }

  // Set the maximum time to wait, if not set
  if (typeof maxWaitTime === 'undefined' || maxWaitTime === null) {
    maxWaitTime = defaultMaxWaitTime;
  }

  var waitUntil = new Date();
  if (maxWaitTime > 0) { // a 0 or -1 mean wait up to forever
    waitUntil.setMilliseconds(waitUntil.getMilliseconds() + maxWaitTime);
  }
  function check() {
    if(test()) {
      callback(null);
    }
    else if (maxWaitTime >= 0 && waitUntil <= new Date()) {
      console.log('Waited too long; continuing...');
      callback({
        message: 'Timed out waiting for operation to complete'
      });
    }
    else {
      setTimeout(check, interval);
    }
  }
  // Always try the first check asynchronously so there is no chance
  // of calling the callback before returning
  process.nextTick(function () {
    check();
  });
}
