'use strict';
var Promise = require('bluebird');
var util = require('util');
var EventEmitter = require('events').EventEmitter;

var EC2_INSTANCE_STATE_CHANGE_EVENT_TYPE = 'EC2 Instance State-change Notification';
var EC2_INSTANCE_HEALTH_FAIL_EVENT_TYPE = 'EC2 Instance Health Failure Notification';
var EC2_INSTANCE_LB_REGISTRATION_EVENT_TYPE = 'AWS API Call via CloudTrail'; // Get appropriate event

var exports, Listener, AWS;
Listener = exports = module.exports = createListener;
util.inherits(Listener, EventEmitter);

/**
 * Create a new Listener or type
 * @param   {object} options AWS Connection parameters for listener
 * @returns {object} AWS Event Listener Object
 */
function createListener(awsConnection, options) {
    var self = this;
    AWS = awsConnection;
    self.processingTimeout = options.processingTimeout || undefined; // default for the queue
    self.pollTimeout = options.pollTimeout || 20;

    self.state = 'Stopped';
    self.queue = options.queue || "";

    /* Listen for availability alarm events from SQS */
    self.sqs = new AWS.SQS();
    self.sqs.receiveMessageAsync = Promise.promisify(self.sqs.receiveMessage);

    self.ec2 = new AWS.EC2();
    self.ec2.describeInstancesAsync = Promise.promisify(self.ec2.describeInstances);
    self.ec2.describeTagsAsync = Promise.promisify(self.ec2.describeTags);

    self.elb = new AWS.ELB();
    self.elb.describeLoadBalancersAsync = Promise.promisify(self.elb.describeLoadBalancers);

    self.autoScaling = new AWS.AutoScaling();
    self.autoScaling.describeAutoScalingInstancesAsync = Promise.promisify(self.autoScaling.describeAutoScalingInstances);

    self.autoScaling.describeLoadBalancersAsync = Promise.promisify(self.autoScaling.describeLoadBalancers);

    return self;
}

Listener.prototype.startAsync = Promise.promisify(start);

/**
 * Starts the Listener
 */
Listener.prototype.start = start;

function start(callback) {
    var self = this;

    console.log('listener::Starting listener for ' + self.queue);
    self.state = 'Started';
    self.listen = true;

    process.nextTick(function () {
        self.tryRead();
    });

    if (typeof callback === 'function') {
        process.nextTick(function () {
            callback(null);
        });
    }
}

/**
 * Submit a read request to AWS
 */
Listener.prototype.tryRead = function () {
    var self = this;

    console.log(self.queue);
    console.log('listener::Reading from queue...');
    self.sqs.receiveMessageAsync({
            QueueUrl: self.queue,
            MaxNumberOfMessages: 1,
            VisibilityTimeout: self.processingTimeout,
            WaitTimeSeconds: self.pollTimeout
        })
        .then(function (data) {
            console.log('listener::Finished polling');
            if (data && data.Messages && data.Messages[0]) {
                var message = data.Messages[0];
                return self.processMessage(message);
            }
        })
        .catch(function (err) {
            console.log(err)
                // TODO: Should we reset the SQS client here?
            if (err.toString().indexOf('CredentialsError') !== -1 || err.toString().indexOf('UnauthorizedException') !== -1) {
                console.log('listener::Fatal error: ' + err);
                self.stop();
            } else {
                console.log('listener::Error receiving message: ' + err);
            }
        })
        .then(function () {
            if (self.listen) {
                process.nextTick(function () {
                    self.tryRead();
                });
            } else {
                self.state = 'Stopped';
                self.emit('stopped', undefined);
            }
        });
};

/**
 * Acknowledge/Delete SQS Message
 * @param {string} deletionToken Message Reference Token
 */
Listener.prototype.deleteMessage = function (deletionToken) {
    var self = this;

    console.log('listener::Deleting message from queue');
    self.sqs.deleteMessage({
        QueueUrl: self.queue,
        ReceiptHandle: deletionToken
    }, function (err, response) {
        if (err) {
            console.log('listener::Error when deleting message: ' + err);
        }
    });
};

/**
 * Shuts down a Listener Channel
 */
Listener.prototype.stop = stop;

function stop() {
    var self = this;

    self.state = 'Stopping';
    self.listen = false;
}

Listener.prototype.processMessage = function (message) {
    var self = this;

    // Note: the identifier used for deletion is the receipt handle, not the message id
    var deletionToken = message.ReceiptHandle;

    console.log('processing: processing message');
    self.emit('message', message);
    try {
        message = JSON.parse(message.Body);
        if (message.Message) {
            message = JSON.parse(message.Message);
        }
    } catch (err) {
        console.log('listener::Failed to parse:' + '\nError: ' + err + '\nMessage: ' + message);
    }

    console.log(message['detail-type']);
    if (message['detail-type'] === EC2_INSTANCE_LB_REGISTRATION_EVENT_TYPE) {

        if (!messageValidate(message)) {
            throw new Error('LB Registration event does not contain valid data');
        }
        var instanceIds = message.detail.requestParameters.instances.map(
            instance => instance.instanceId
        );
        var loadBalancerName = message.detail.requestParameters.loadBalancerName;
        var eventName = message.detail.eventName;

        console.log('listener::Found ' + instanceIds.join(', ') + ' received instruction ' +
            eventName + ' with loadbalancer ' + loadBalancerName);

        console.log("Attempting to resolve load balancer, instance registered");
        return self.resolveLoadBalancer(instanceIds[0])
            .then(function () {
                console.log("LoadBalancer Resolved");
                return self.ec2.describeInstancesAsync({
                    InstanceIds: instanceIds
                });
            })
            // TODO: Stop retrieving details if/when removal only needs instance ID
            // Retrieve instance details
            .then(function (instanceDetails) {
                var instances = [];
                instanceDetails.Reservations.forEach(reservation => {
                    reservation.Instances.forEach(instance => {
                        if (instance.InstanceId) {
                            instances.push(instance);
                        } else {
                            throw new Error("Did no retreive expected valid instance details.", instanceDetails);
                        }
                    });
                });
                return instances;
            })
            .then(function (instances) {
                console.log("Processing instances", JSON.stringify(instances, null, 1));
                instances.forEach(instance => {
                    instance.region = message.region;
                });
                if (eventName === 'DeregisterInstancesFromLoadBalancer') {
                    console.log('Instance is Rotation State Down:');
                    self.emit('instance-rotate-out', {
                        deletionToken: deletionToken,
                        instances
                    });
                } else if (eventName === 'RegisterInstancesWithLoadBalancer') {
                    console.log('Instance is Rotation State Up:');
                    self.emit('instance-rotate-in', {
                        deletionToken: deletionToken,
                        instances
                    });
                } else {
                    console.log("Skipping non-registration change");
                }
            }).catch(function (err) {
                console.log('listener::' + err);
            });
    } else {
        console.log('listener::Unsupported state ' + eventName);
        return self.deleteMessage(deletionToken);
    }
};

/**
 * Check for valid API LB de/register event
 * @param   {Event.detail}   detail AWS Event Message detail
 * @returns {[[Type]]} [[Description]]
 */
function messageValidate(message) {
    var detail = message.detail;
    var rp = detail.requestParameters;
    return (rp.instances &&
        rp.instances.filter(instance => instance.instanceId) &&
        rp.loadBalancerName &&
        detail.eventName);
}

/**
 * For a given Autobalanced Instance, retrieve Load Balancers
 * @throws {Error} Load Balancer Not found or not Autoscaled
 * @param   Object instance  Combined EC2 instance object.
 * @param   String instanceId AWS identifier for EC2 Instance
 * @returns Promise  Promise, network AWS.AutoBalancer requests status.
 */
Listener.prototype.resolveLoadBalancer = function resolveLoadBalancer(instanceId) {
    var self = this;
    console.log('Attempt to get AB group for', instanceId);
    return self.autoScaling.describeAutoScalingInstancesAsync({
            InstanceIds: [instanceId]
        })
        .then(function (autoScaleInstances) {
            if (autoScaleInstances && autoScaleInstances.length > 0) {
                throw new Error("Cannot monitor Autoscaled instances");
            }
            return instanceId;
        })
        .then(function () {
            console.log("attempting to get loadbalancers");
            return self.elb.describeLoadBalancersAsync()
        })
        .then(function (response) {
            console.log("lb response", response);
            var loadBalancers = response.LoadBalancerDescriptions;
            return loadBalancers.filter(function (loadBalancer) {
                return loadBalancer.Instances.filter(function (instance) {
                    return instance.InstanceId === instanceId;
                });
            })
        })
        .then(function (loadBalancers) {
            if (!loadBalancers || loadBalancers.length < 1) {
                throw new Error("No LoadBalancer found");
            }
            return loadBalancers;
        })
        .catch(function (err) {
            console.log("err resolving lb", err);
            return null;
        });
};


/**
 * No Operation
 */
function noop() {}
