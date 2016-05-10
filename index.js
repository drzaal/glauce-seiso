'use strict';

var Orchestrator = require('./orchestrator');

var ImportService = module.exports = exports = createImportService;

/*
 * Create an AWS ELB listener instance
 *
 * Config values:
 *   `listener` {Object} AWS listener configuration:
 *     `queue` {string} AWS SQS queue on which to listen for ELB state events,
 *        e.g. https://sqs.[region].amazonaws.com/[account]/[queue-name]
 *     `credentials` {Object} AWS account credentials
 *       `accessKeyId` {string} AWS account access key identifier
 *       `secretAccessKey` {string} AWS account secret access key
 *     `region` {string} AWS region containing the SQS queue, e.g. us-west-2
 *   `seisoClient` {Object} Seiso client configuration:
 *     `url` {string} root Seiso API URL, e.g. https://seiso-api.example.com/api
 *     `username` {string} Seiso username
 *     `password` {string} Seiso password, base-64 encoded
 *   `mapper` {Array} optional set of 1:1 AWS tag to Seiso settings
 *     `tagName` AWS tag name
 *     `propertyName` Seiso setting name in a dot-separated format, e.g. service.key
 *   `customMappers` {Array} optional set of custom mappers
 *     `name` {string} friendly name, e.g. for logging
 *     `path` {string} module path, for a require call; must be available locally
 *     `config` {Object} free-form config as required for your custom mapper
 *
 * Custom mappers must implement the following members:
 *   `name` {string} identifies the custom mapper, e.g. in logs  
 *   `start` {function} take any action necessary to initialize with node-style
 *      callback for success/failure
 *   `stop` {function} take any action necessary to spin down/free resources with
 *      node-style callback for success/failure
 *   `map` {function} accept the current Seiso node as input, return a node with
 *      any additional mapped details
 *
 * Custom mappers are executed synchronously, so that the output from the first
 * custom mapper will be the input to the second
 **/
function createImportService(config) {
  if (!(this instanceof createImportService)) { return new createImportService(config); }
  console.log("making a new service", config);
  var self = this;

  var orchestrator = new Orchestrator(config);

  /**
   * Start the orchestration if not starting/started
   * @param {Function} callback Callback function (with err param)
   * @return {Boolean} true if a start was initialized; false otherwise
   * @api public
   **/
  self.start = function (callback) {
    return orchestrator.start(callback);
  };

  /**
   * Stop the orchestration if not stopping/stopped
   * @param {Function} callback Callback function (with err param)
   * @return {Boolean} true if a stop was initialized; false otherwise
   * @api public
   **/
  self.stop = function (callback) {
    return orchestrator.stop(callback);
  };

  /**
   * Get the state of orchestration, which can be:
   *   `Stopped` if not running or in transition
   *   `Started` if running
   *   `Starting` if starting up
   *   `Stopping` if spinning down/ceasing operation
   *   `Unknown` in an error condition/state is not known
   *
   * @return {string} orchestration state, see above
   * @api public
   **/
  self.getState = function getState() {
    return orchestrator.getState();
  };

  /**
   * Bootstrap the SNS topic, SQS queue, and permissions
   * Refer to bootstrap module's execute function
   * for configuration details
   *
   * @param {Object} config Configuration
   * @api public
   **/
  self.bootstrap = require('./bootstrapper').execute;

}
