var chai = require('chai');
var sinon = require('sinon');
var mockery = require('mockery');
var expect = chai.expect;
var assert = chai.assert;

var configMock;
var RotationListener, rotationListener;

describe('Module Seiso AWS LB Rotation State Listener', function () {
  this.timeout(30000);

  var rq, rp, sdk;
  before(function () {
    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    rq = sinon.stub()
    rp = sinon.stub()
    sdk = sinon.stub()
    mockery.registerMock('./app.config', configMock);
    // mockery.registerMock('request', rq);
    // mockery.registerMock('request-promise', rp);
    //mockery.registerMock('aws-sdk', sdk);
    RotationListener = require('../index.js');
  });
  after(function () {
    mockery.disable();
  });
  describe('Start and watch service', function () {
    it('empty test starts', function () {
      rotationListener = RotationListener(configMock);
    });
    it('outputs expected logs to console', function (done) {
      rotationListener.start(configMock);
      
      expect(rp.called).is.false;
      expect(rq.called).is.false;
      expect(sdk.called).is.false;
      setTimeout(done, 30000)
    });
  });
});

configMock = require('../env.conf.js');
