'use strict';
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var Promise = require('bluebird');
var seisoClient;

var AWS;
var Feeder = exports = module.exports = createFeeder;
util.inherits(Feeder, EventEmitter);

/**
 * Create a new Feeder or type
 * @param   {object} options AWS Connection parameters for feeder
 * @returns {object} AWS Event Feeder Object
 */
function createFeeder(awsConnection, seisoConnection, options) {
  var self = this;
  if (!options) { options = {}; }
  if (!awsConnection) { throw new Error("Invalid or unspecified AWS connection handler provided."); }
  if (!seisoConnection) { throw new Error("Invalid or unspecified Seiso connection handler provided."); }
  AWS = awsConnection;
  seisoClient = seisoConnection;

  self.pollInterval = options.pollInterval || 300; // Default 5 minutes to reevaluate uptime status.
  self.processingTimeout = options.processingTimeout || undefined; // default for the queue
  self.pollTimeout = options.pollTimeout || 20;

  self.state = 'Stopped';

  self.ec2 = new AWS.EC2();
  self.ec2.describeInstancesAsync = Promise.promisify(self.ec2.describeInstances);
  self.ec2.describeInstanceStatusAsync = Promise.promisify(self.ec2.describeInstanceStatus);
  self.ec2.describeTagsAsync = Promise.promisify(self.ec2.describeTags);
  
  self.elb = new AWS.ELB();
  self.elb.describeLoadBalancersAsync = Promise.promisify(self.elb.describeLoadBalancers);

  self.autoScaling = new AWS.AutoScaling();
  self.autoScaling.describeAutoScalingInstancesAsync = Promise.promisify(self.autoScaling.describeAutoScalingInstances);

  self.autoScaling.describeLoadBalancersAsync = Promise.promisify(self.autoScaling.describeLoadBalancers);

  return self;
}

Feeder.prototype.startAsync = Promise.promisify(start);

/**
 * Starts the Feeder
 */
Feeder.prototype.start = start;

function start(callback) {
  var self = this;

  console.log('feeder::Starting feeder for AWS instances');
  self.state = 'Started';
  self.feeding = true;
	
  self.feeding = setTimeout(self.tryGet, self.interval);
	callback(null);

}

/**
 * Query AWS for Node Health Status
 */
Feeder.prototype.tryGet = function () {
  var self = this;

  console.log('feeder:: Starting Health Checks...');
	// Seiso get all SQS LB.
  
	seisoClient.connectAsync()
  .then(seisoClient.getLoadBalancersAsync.bind(seisoClient))
		.then(processLoadBalancers);

};

/**
 * Process Data Response
 * @param JSON Seiso API response LB records
 */
function processLoadBalancers(lbs) {
  lbs.filter(function(lb) { return lb.type === 'aws'; })
  return lbs;
}

function getAwsNodes(lbs) {
  var siNodesGetters = [];
  for (var lb in lbs) {
    var serviceInstance = lbs[lb].serviceInstance;
    siNodesGetters.push(seisoClient.findNodesByServiceInstanceAsync({ serviceInstance: serviceInstance }))
  }
  return Promise.all(siNodesGetters);
}

function processNodes(response) {
  var nodes = [];
  if (!response._embedded) {
    for (var siSubset in response){
      nodes = nodes.concat(response[siSubset]._embedded.items);
    }
  }
  else {
    nodes = response._embedded.items;
  }
  return nodes;
}
/**
 * Generate a Health Request
 */
//Feeder.prototype.

/**
 * Shuts down a Feeder Channel
 */
Feeder.prototype.stop = stop;

function stop() {
  var self = this;

  self.state = 'Stopping';
  if (self.feeder) {
    clearInterval(self.feeder);
  }
}

/**
 * Refresh health state for nodes
 */
Feeder.prototype.requestHealth = function requestHealth() {
    Promise.all([
        seisoClient.getLoadBalancersAsync().then(mapper.processToLbs),
        seisoClient.getNodesAsync().then(mapper.processToNodes)
    ])
    .then(mapNodesLbs)
    .then(function(nodes) {
        var healthRequest = {
            
            
        };
        var chunks = chunk(nodes, config.nodeBin || 5)
        for (var chunk in chunks) {
            chunks[chunk] = self.ec2.describeInstanceStatusAsync({
                instances: chunks[chunk]
            })
            .then(seisoClient.patchAggregateRotationStatus);
        }
        return Promise.all(chunks);
    })
};

function chunk(array, chunkSize) {
    if (chunkSize < 1) return array;
    var silos = [];
    for (var i=0, j=array.length; i<j; i+=chunk) {
        silo.push(array.slice(i, i+chunk));
    }
    return silos;
}

/**
 * For a given Autobalanced Instance, retrieve Load Balancers
 * @throws {Error} Load Balancer Not found or not Autoscaled
 * @param   Object instance  Combined EC2 instance object.
 * @param   String instanceId AWS identifier for EC2 Instance
 * @returns Promise  Promise, network AWS.AutoBalancer requests status.
 */
Feeder.prototype.resolveLoadBalancer = function resolveLoadBalancer(instance, instanceId) {
  var self = this;

  return self.autoScaling.describeAutoScalingInstancesAsync({
    InstanceIds: [instanceId]
  })
  .then(function (autoScaleInstances) {
    if (!autoScaleInstances || autoScaleInstances.length < 1) {
      throw new Error("Not AutoScaled");
    }
    var autoScaleGroup = autoScaleInstances[0].AutoScalingGroupName;
    self.autoScaling.describeLoadBalancersAsync({
        AutoScalingGroupName: autoScaleGroup
      })
      .then(function (loadBalancers) {
        if (!loadBalancers || loadBalancers.length < 1) {
          throw new Error("No LoadBalancer found");
        }
        loadBalancers.map(function (loadBalancer) {
          if (loadBalancer.State !== "Removing") {
            instance.loadBalancer = (loadBalancer.LoadBalancerName);

            if (loadBalancer.ListenerDescriptions) {
              instance.ports = [];
              loadBalancer.ListenerDescriptions.map(function(port) {
                instance.ports.push( port.InstancePort );
              });
            }
          }
        });
        return instance;
      });
  })
  .catch(function () {
    return instance;
  });
};


/**
 * No Operation
 */
function noop() {}
