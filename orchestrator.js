'use strict';

var util = require('util');
var EventEmitter = require('events').EventEmitter;
var Promise = require('bluebird');

var AWS = require('aws-sdk');

var Listener = require('./listener');
var Feeder = require('./feeder');
var SeisoClient = require('./seisoClient'); // Best to extract the seisoClient from the module
var Mapper = require('./mapper');

var Orchestrator = module.exports = exports = createOrchestrator;
util.inherits(Orchestrator, EventEmitter);

function createOrchestrator(config) {
    if (!(this instanceof createOrchestrator)) {
        return new createOrchestrator(config);
    }
    console.log('Bootstrapping orchestrator...');
    var self = this;

    var state = 'Stopped';

    // All private dependencies; lifespan is start to stop
    var listener, feeder, seisoClient, mapper, customMappers;

    // Note: functions start, stop, getState instantiated here
    // to preserve access to the private variables in this closure

    /**
     * Start the orchestration if not starting/started
     * @param {Function} callback Callback function (with err param)
     * @return {Boolean} true if a start was initialized; false otherwise
     * @api public
     **/
    this.start = function start(callback) {
        if (state === 'Started') {
            if (typeof callback === 'function') {
                process.nextTick(function () {
                    callback(null);
                });
            }
            return false;
        }

        // Bind to started (and stopped) event for callback resolution if needed
        // Note: done on next tick to ensure no immediate execution
        if (typeof callback === 'function') {
            var notified = false;
            process.nextTick(function () {
                self.once('started', function () {
                    notified = true;
                    callback(null);
                });
            });

            process.nextTick(function () {
                self.once('stopped', function (event) {
                    if (!notified) {
                        callback(event.Error || 'Stopped for unknown reason');
                    }
                });
            });
        }

        if (state === 'Starting') { // Starting already, do not kick off again
            return false;
        }

        console.log('Starting up...');
        state = 'Starting';

        // Bootstrap listener, seiso client, and mapper
        // First, instantiate each component

        var credentials = config.listenerCredentials || config.bootstrapperCredentials;

        console.log("Connect/configure AWS options", config);
        AWS.config.update({
            region: config.listenerCredentials.region
        });
        AWS.config.update({
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey
        });

        seisoClient = new SeisoClient(config.seisoClient);

        listener = new Listener(AWS, config.listener);
        feeder = new Feeder(AWS, seisoClient, config.feeder);
        mapper = new Mapper(config.mapper);
        
        /**
         * Get Cached Data/
         */
        self.rotationStatuses = [];
        seisoClient.getRotationStatuses()
        .then(function (rs) { self.rotationStatuses = rs; });

        /**
         * Bootstrap any custom mappers. Custom mappers perform translation on node to
         * suit your specific infrastructure and application needs; Custom mapper modules must:
         *   - export a constructor
         * Custom mapper instances must:
         *   - include a name property
         *   - have a node callback-style start function
         *   - have a node callback-style stop function
         *   - have a node callback-style map function that returns the translated node
         */
        customMappers = [];
        if (config.customMappers && Array.isArray(config.customMappers)) {
            for (var i = 0; i < config.customMappers.length; i++) {
                // TODO: Stop requiring custom mappers here; they should be passed in, already instantiated
                var CustomMapper = require(config.customMappers[i].path);
                customMappers.push(new CustomMapper(config.customMappers[i].config));
            }
        }

        // Next, bind to any component events
        // TODO ELB listener events
        listener.on('message', messageReceivedHandler);
        listener.on('instance-rotate-in', instanceRotateInHandler);
        listener.on('instance-rotate-out', instanceRotateOutHandler);

        // Finally, initialize all components as needed
        var listenerStarting = listener.startAsync();
        var feederStarting = feeder.startAsync();
        var seisoClientStarting = seisoClient.connectAsync();
        var customMapperStartings = [];
        for (var i = 0; i < customMappers.length; i++) {
            var startAsync = Promise.promisify(customMappers[i].start);
            customMapperStartings.push(startAsync());
        }

        Promise.all([listenerStarting, feederStarting, seisoClientStarting].concat(customMapperStartings))
            .catch(function (err) {
                state = 'Stopped';
                self.emit('stopped', {
                    Error: err
                });
            })
            .then(function () {
                state = 'Started';
                self.emit('started', null);
            });

        return true;
    };

    /**
     * Stop the orchestration if not stopping/stopped
     * @param {Function} callback Callback function (with err param)
     * @return {Boolean} true if a stop was initialized; false otherwise
     * @api public
     **/
    this.stop = function stop(callback) {
        if (state === 'Stopped') {
            if (typeof callback === 'function') {
                process.nextTick(function () {
                    callback(null);
                });
            }
            return false;
        }

        var notified = false;
        if (typeof callback === 'function') {
            process.nextTick(function () {
                self.once('stopped', function () {
                    if (!notified) {
                        callback(null);
                    }
                });
            });
        }

        if (state === 'Stopping') {
            return false;
        }

        console.log('Shutting down');
        state = 'Stopping';

        feeder.stop();

        var feederStopping = new Promise(function (resolve, reject) {
            resolve();

        });

        var listenerStopping = new Promise(function (resolve, reject) {
            listener.once('stopped', function () {
                console.log('Listener stopped');
                listener.removeListener('message', messageReceivedHandler);
                listener.removeListener('instance-rotate-in', instanceRotateInHandler);
                listener.removeListener('instance-rotate-out', instanceRotateOutHandler);
                listener = null;
                resolve();
            });
        });

        listener.stop();

        // TODO: Stop seiso client safely

        var customMapperStoppings = [];
        for (var i = 0; i < customMappers.length; i++) {
            var stopAsync = Promise.promisify(customMappers[i].stop);
            customMapperStoppings.push(stopAsync());
        }


        Promise.all([listenerStopping, feederStopping].concat(customMapperStoppings))
            .catch(function (err) {
                notified = true;
                state = 'Unknown';
                if (typeof callback === 'function') {
                    process.nextTick(function () {
                        callback({
                            Error: err
                        });
                    });
                }
            })
            .then(function () {
                state = 'Stopped';
                self.emit('stopped', null);
            });

        return true;
    };

    this.getState = function () {
        return state;
    };

    /**
     *  instanceCreatedHandler
     *  Event handler for new instance events, triggered by AWS Listener
     **/
    function instanceRotateInHandler(event) {

        if (event.instances) {
            
            var rs = self.rotationStatuses.find(rs => rs.key === "enabled");
            console.log('Instance rotation status up: ' + event.instances.map(i => i.InstanceId).join(', '));
            var rotationPromise = event.instances.map(
                instance => rotateInstance(instance, rs._links.self.href)
            );

            Promise.all(rotationPromise)
                .then(function () {
                    console.log('Rotation State Updated');
                    listener.deleteMessage(event.deletionToken);
                })
                .catch(function (err) {
                    console.log('Node rotation state update failed: ', err);
                });
        }
    }

    function rotateInstance(instance, state) {
        var node;
        instance.state = state;
        var validationErrors = mapper.validateMessage(instance);
        if (typeof validationErrors !== 'undefined' && validationErrors !== null && validationErrors.length > 0) {
            console.log('Instance details not valid:', validationErrors);
            return Promise.reject(validationErrors);
        }

        node = mapper.instanceToNode(instance);

        // Perform any custom mapping
        function map(mappers, index, node, callback) {
            if (!mappers || mappers.length <= index) {
                // When no more mapping functions remain, call original callback
                callback(null, node);
            } else {
                // Call the next mapper
                console.log('Calling ' + mappers[index].name + ' custom mapper')
                mappers[index].map(node, function (err, node) {
                    if (err) {
                        callback({
                            mapper: mappers[index].name,
                            error: err
                        });
                    } else {
                        map(mappers, index + 1, node, callback);
                    }
                })
            }
        }

        return new Promise(function (resolve, reject) {
            map(customMappers, 0, node, function (err, node) {
                if (err) {
                    console.log('Failed to perform custom mapping: ', err);
                } else {
                    console.log('Updating Rotation Status:');
                    console.log(node);
                    resolve(seisoClient.findNodesAsync({
                            name: node.name,
                            filters: [
                                {
                                    type: 'Tag',
                                    name: 'AWS Instance ID',
                                    value: node.tags['AWS Instance ID']
                                }
                            ]
                        })
                        .then(function (nodeResponse) {
                            if (nodeResponse.length < 1) throw new Error("No matching Node Records found for instance");
                            if (nodeResponse.length > 1) throw new Error("Multiple matching Node Records found for instance");
                            return nodeResponse;
                        })
                        .then(function(nodeResponse) {
                            seisoClient.patchNodeAggregateRotationStatus(nodeResponse, state);
                        })
										);
                }
							});
					});
			}

			/**
			 *  instance Rotation State Out Handler
			 *  Event handler for deleted instance events, triggered by AWS Listener
			 **/
			function instanceRotateOutHandler(event) {
					console.log('Instance out of rotation: ' + JSON.stringify(event, null, 1));
					if (event.instances) {
							var rs = self.rotationStatuses.find(rs => rs.key == "disabled");
							var rotationPromise = event.instances.map(
									instance => rotateInstance(instance, rs._links.self.href)
							);

							Promise.all(rotationPromise)
									.then(function () {
											console.log('Rotation State Updated');
											listener.deleteMessage(event.deletionToken);
									})
									.catch(function (err) {
											console.log('Node rotation state update failed: ', err);
									});
					}
			}

			function messageReceivedHandler() {
					console.log(JSON.stringify(arguments, null, 4));
			}

			console.log('Orchestrator bootstrapped');
}
