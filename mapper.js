'use strict';

var exports = module.exports = createMapper;


function createMapper(options) {
    if (!(this instanceof createMapper)) {
        return new createMapper(options);
    }
    var self = this;
    if (options) {
        self.serviceTagKey = options.seviceTagKey;
        self.environmentTagKey = options.environmentTagKey;
    }
}

/**
 * Validate incoming Message resolves to valid instance and State
 * @returns {[[Type]]} [[Description]]
 */
createMapper.prototype.validateMessage = function validateMessage(details) {
    // Validate instance details
    var service, environment;
    var validationErrors = [];
    console.log("validating", details);
    
    var instanceId = details.InstanceId;
    
    if (typeof instanceId !== 'string' || instanceId.length === 0) {
        validationErrors.push('Instance ID not present');
    }

    if (typeof details === 'undefined' || details === null) {
        validationErrors.push('Instance details not present');
        return validationErrors;
    }

    var name, fqdn, domain;
    if (!details.PrivateDnsName) {
        validationErrors.push('Instance not named');
    } else {
        fqdn = details.PrivateDnsName;
        var parsedName = fqdn.split('.');
        if (parsedName.length < 2) {
            validationErrors.push('Instance DNS name not an FQDN');
        }
    }

    return validationErrors;
}

createMapper.prototype.getInstance = function getInstance() {

}

createMapper.prototype.instanceToNode = function instanceToNode(instance) {
    var node = {};
    
    var instanceId = instance.InstanceId;
    var machineName = instance.PrivateDnsName;
    var parsedName = machineName.split('.');
    var hostname = parsedName.shift();
    var domain = parsedName.join('.');

    // Map to seiso input
    node = {
        name: instanceId,
        machineName: machineName,
        hostname: hostname,
        aggregateRotationStatus: instance.status === 'down',
        tags: {
            'AWS Instance ID': instanceId
        }
    };
    return node;
}

createMapper.prototype.alarmToLb = function alarmToLb() {}

function seisoResponseExtract(resource, response) {
    return response._embedded.items;
}
createMapper.prototype.seisoResponseExtractLbs = function seisoResponseExtractLbs(response) {
    return seisoResponseExtract("loadBalancers", response)
}
createMapper.prototype.seisoResponseExtractNodes = function seisoResponseExtractNodes(response) {
    return seisoResponseExtract("nodes", response)
}
