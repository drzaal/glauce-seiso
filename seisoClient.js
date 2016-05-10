'use strict';

var Promise = require('bluebird');
var requestAsync = require('request-promise');
var endecoder = require('./endecoder');
var common = require('./common');

var ERROR_NOT_FOUND = 404,
    ERROR_CONFLICT = 409;

var SeisoClient = exports = module.exports = createSeisoClient;

function createSeisoClient(options) {
    var self = this;

    self.url = options.url;
    self.username = options.username;
    self.password = options.password;
    self.rejectUnauthorized = options.rejectUnauthorized || false;
    self.environments = options.environments || {};
    self.dataCenters = options.dataCenters || {};
    self.preCache = preCacheDomainData(self);

    if (self.url && self.username && self.password) {
        return self;
    } else {
        throw new Error('Invalid or incomlete configuration for seisoClient.');
    }
}

/**
 * Smoke tests the seiso connection/config
 **/
SeisoClient.prototype.connectAsync = function () {
    console.log('Connecting to seiso@' + this.url);
    return seisoRequest(this, '')
        .catch(function (err) {
            return Promise.reject({
                Error: err
            });
        })
        .then(function () {
            return Promise.resolve();
        });
};

/**
 * "Upsert" a node with `params` (create if does not exist,
 * including related entities service, service instance, machine,
 * where applicable; update if it does exist)
 *
 * Params:
 *
 *   - `service` {String} service key
 *   - `environment` {String} environment, e.g. 'aws-test'
 *   - `environmentType` {String} environment type, e.g. 'test'
 *   - `loadBalanced` {Boolean} flag indicating if machine is behind
 *       load balancer
 *   - `loadBalancer` {String} load balancer name, if applicable
 *   - `dataCenter` {String} Data center
 *   - `owner` {String} owner name or identifier
 *   - `name` {String} node name
 *   - `machineName` {String} machine name
 *   - `hostname` {String} machine FQDN
 *   - `domain` {String} machine domain
 *   - `os` {String} machine Operating System, e.g. 'linux'
 *   - `platform` {String} machine platform
 *   - `ipAddress` {String} machine IP address
 *   - `ports` {Array of Number} service instance ports
 *   - `tags` {Object} tags, with tag key as property name and tag
 *       value as property value, e.g. tags['source'] = 'aws'
 *
 * @param {Object} params
 * @param {Function} callback Callback function (with err, data params)
 * @api public
 **/
SeisoClient.prototype.upsertNodeAsync = function (params) {
    var self = this;

    // Validate input
    var validationErrors = [];
    if (!params.tags || !params.tags['AWS Instance ID']) {
        validationErrors.push('Required tag \'AWS Instance ID\' not present');
    }

    if (!params.ports || !Array.isArray(params.ports) || params.ports.length === 0) {
        validationErrors.push('At least one port must be specified (or ports are not in correct format)');
    }

    // TODO: Validate other params, e.g. name, service, etc.

    if (validationErrors.length > 0) {
        return Promise.reject({
            message: 'One or more validation errors was found',
            validationErrors: validationErrors
        });
    }

    // Get node, if it exists;
    // Also, make sure there is not already an issue with duplicates in Seiso
    var node, serviceLink, serviceInstanceId, serviceInstanceLink;

    return self.findNodesAsync({
            name: params.name,
            filters: [
                {
                    type: 'Tag',
                    name: 'AWS Instance ID',
                    value: params.tags['AWS Instance ID']
      }
    ]
        })
        .then(function (matchingNodes) {
            if (matchingNodes && Array.isArray(matchingNodes) && matchingNodes.length > 1) {
                console.log('Multiple nodes found for criteria: name ' + params.name + ', instance ' + params.tags['AWS Instance ID']);
                return Promise.reject({
                    message: 'Multiple nodes already exist with that AWS instance ID'
                });
            } else if (matchingNodes) {
                console.log('Node exists; updating')
                node = matchingNodes;
            }
            return self.getServiceAsync(params.service);
        })
        .then(function (existingService) {
            // Create service if it does not exist
            if (existingService === null || typeof existingService === 'undefined') {
                console.log('No service ' + params.service + '; creating')
                return self.createServiceAsync({
                    key: params.service,
                    name: params.service
                });
            } else {
                return Promise.resolve(existingService);
            }
        })
        .then(function (service) {
            serviceLink = getRestRecordLink(service);

            // Check for Service Instance
            return self.getServiceInstanceAsync(params.service, params.environmentType);
        })
        .then(function (serviceInstance) {
            // Create service instance if it does not exist
            if (serviceInstance === null || typeof serviceInstance === 'undefined') {
                console.log('No service instance for ' + params.service + ', env category ' + params.environmentType + '; creating');
                return self.preCache
                    .then(function () {
                        return self.createServiceInstanceAsync({
                            key: params.service + '-' + params.environmentType,
                            service: serviceLink,
                            environment: (self.environments[params.environment] ? getRestRecordLink(self.environments[params.environment]) : null),
                            dataCenter: (self.dataCenters[params.dataCenter] ? getRestRecordLink(self.dataCenters[params.dataCenter]) : null),
                            ports: params.ports,
                            loadBalanced: params.loadBalanced,
                            // TODO: Support looking up (and creating?) load balancer
                            loadBalancer: params.loadBalancer
                        });
                    });
            } else {
                return Promise.resolve(serviceInstance);
            }
        })
        .then(function (serviceInstance) { // Upsert machine record
            serviceInstanceId = getRestRecordId(serviceInstance);
            serviceInstanceLink = getRestRecordLink(serviceInstance);

            console.log('Upserting machine ' + params.machineName);

            return self.preCache
                .then(function () {
                    return self.upsertMachineAsync({
                        name: params.machineName,
                        hostname: params.hostname,
                        domain: params.domain,
                        os: params.os,
                        platform: params.platform,
                        ipAddress: params.ipAddress,
                        dataCenter: (self.dataCenters[params.dataCenter] ? getRestRecordLink(self.dataCenters[params.dataCenter]) : null)
                    });
                });
        })
        .then(function (machine) {
            var nodeUpsert;
            // Create node if it does not exist
            if (!node) {
                console.log('Node ' + params.name + ' was not found; creating');
                nodeUpsert = self.createNodeAsync({
                    name: params.name,
                    version: '1.0.0',
                    serviceInstanceId: serviceInstanceId,
                    serviceInstanceLink: serviceInstanceLink,
                    machine: getRestRecordLink(machine),
                    ipAddresses: [params.ipAddress],
                    tage: params.tags
                });
            } else {
                // Update, if necessary
                // TODO: Consider conditionally calling update (i.e. only if data has changed)
                console.log('Updating node ' + params.name);
                nodeUpsert = self.updateNodeAsync(node, {
                    name: params.name,
                    version: '1.0.0',
                    serviceInstanceId: serviceInstanceId,
                    serviceInstanceLink: serviceInstanceLink,
                    machine: getRestRecordLink(machine),
                    ipAddresses: [params.ipAddress],
                    tags: params.tags
                });
            }

            return nodeUpsert;
        });
}

/**
 * Remove node from Seiso by `options`; note for MVP support will
 * be limited to removal by name
 *
 * Options:
 *
 *   - `name` {String} node name
 *   - `filters` {Array of Object} node filter(s), where a filter has:
 *       - `type` {String} filter type; supported values include:
 *           - 'Tag'
 *       - `name` {String} filter name, e.g. 'AWS Instance ID'
 *       - `value` {String} filter value (case-senstive match),
 *           e.g. 'instance-My123'
 *   - `removeMachine` {Boolean} remove associated machine as well
 *
 * @param {Object} options
 * @api public
 **/
SeisoClient.prototype.removeNodeAsync = function (options) {
    var self = this;

    return seisoRequest(
            // Find the node, if it exists
            self,
            'nodes/search/findByName',
            null, {
                ignoredErrorCodes: [ERROR_NOT_FOUND],
                name: options.name
            }
        )
        .then(function (node) {
            if (node) {
                // Remove machine, if directed
                if (options.removeMachine) {
                    return seisoRequest(
                            self, ['nodes', getRestRecordId(node), 'machine'].join('/')
                        )
                        .then(function (machine) {
                            console.log('Found machine and should remove; queuing removal');
                            return Promise.resolve({
                                node: node,
                                machine: machine
                            });
                        });
                }
            }
            return Promise.resolve({
                node: node,
                machine: null
            });
        })
        .then(function (options) {
            if (options.node) {
                // Remove the node
                console.log('Node was found; removing');
                return seisoRequest(
                        self,
                        'nodes/' + getRestRecordId(options.node),
                        null, {
                            method: 'DELETE'
                        }
                    )
                    .then(function () {
                        return Promise.resolve(options.machine);
                    });
            }

            return Promise.resolve(options.machine);
        })
        .then(function (machine) {
            if (machine) {
                console.log('Removing machine');
                return seisoRequest(
                        self,
                        'machines/' + getRestRecordId(machine),
                        null, {
                            ignoredErrorCodes: [ERROR_NOT_FOUND],
                            method: 'DELETE'
                        }
                    )
                    // If a conflict is received, try a get and confirm no results
                    .catch(function (err) {
                        if (err.statusCode === ERROR_CONFLICT) {
                            return seisoRequest(
                                    self,
                                    'machines/' + getRestRecordId(machine),
                                    null, {
                                        ignoredErrorCodes: [ERROR_NOT_FOUND]
                                    }
                                )
                                .then(function (machine) {
                                    // Ensure no results
                                    if (machine) {
                                        throw new Error('Machine deletion failed with conflict but machine still exists');
                                    }
                                    return Promise.resolve(null);
                                });
                        } else {
                            return Promise.reject(err);
                        }
                    })
                    .then(function () {
                        return Promise.resolve(null);
                    });
            }
        })
};

SeisoClient.prototype.getServiceAsync = function (key) {
    var self = this;

    return seisoRequest(
        self,
        'services/search/findByKey',
        null, {
            ignoredErrorCodes: [ERROR_NOT_FOUND],
            key: key
        }
    );
}

SeisoClient.prototype.getServiceInstanceAsync = function (serviceKey, environment) {
    var self = this;

    return seisoRequest(
        self,
        "serviceInstances/search/findByKey",
        null, {
            ignoredErrorCodes: [ERROR_NOT_FOUND],
            key: serviceKey + "-" + environment
        }
    );
}

/**
 * Retrieve node(s) from Seiso by `options`; note for MVP support will
 * be limited to retrieval by tag
 *
 * Options:
 *
 *   - `filters` {Array of Object} node filter(s), where a filter has:
 *       - `type` {String} filter type; supported values include:
 *           - 'Tag'
 *       - `value` {String} filter value (case-senstive match)
 *
 * @param {Object} options
 * @api public
 **/
SeisoClient.prototype.findNodesAsync = function (options) {
    var self = this;

    // TODO: Search by TAG?
    return seisoRequest(
        self,
        "nodes/search/findByName",
        null, {
            ignoredErrorCodes: [ERROR_NOT_FOUND],
            name: options.name
        }
    );
};


SeisoClient.prototype.getMachinesByNameAsync = function (name) {
    var self = this;

    return seisoRequest(
        self,
        "machines/search/findByName",
        null, {
            ignoredErrorCodes: [ERROR_NOT_FOUND],
            name: options.name
        }
    );
}

SeisoClient.prototype.createServiceAsync = function (params) {
    var self = this;

    return seisoRequest(
        self,
        'services/',
        params, {
            method: 'POST'
        }
    );
}

SeisoClient.prototype.createServiceInstanceAsync = function (serviceInstanceRequest) {
    var self = this;

    return seisoRequest(
            self,
            'serviceInstances/', {
                key: serviceInstanceRequest.key,
                service: serviceInstanceRequest.service,
                environment: serviceInstanceRequest.environment,
                dataCenter: serviceInstanceRequest.dataCenter,
                loadBalanced: serviceInstanceRequest.loadBalanced,
                loadBalancer: serviceInstanceRequest.loadBalancer
            }, {
                method: 'POST'
            }
        )
        // If a conflict occurs, just get the existing service instance
        .catch(function (err) {
            if (err && err.statusCode === ERROR_CONFLICT) {
                return self.getServiceInstanceAsync(serviceInstanceRequest.service, serviceInstanceRequest.environment)
                    .then(function (serviceInstance) {
                        if (!serviceInstance) {
                            return Promise.reject({
                                message: 'Creation of service instance failed with conflict but service instance not found'
                            });
                        }
                        return Promise.resolve(serviceInstance);
                    });
            }
            return Promise.reject(err);
        })
        .then(function (serviceInstance) {
            var serviceInstanceLink = getRestRecordLink(serviceInstance);
            console.log('Created service instance ' + serviceInstanceLink);
            var additionalWork = [];
            for (var i = 0; i < serviceInstanceRequest.ports.length; i++) {
                additionalWork.push(seisoRequest(
                    self,
                    'serviceInstancePorts/', {
                        serviceInstance: serviceInstanceLink,
                        number: serviceInstanceRequest.ports[i],
                        protocol: common.getProtocolFromPort(serviceInstanceRequest.ports[i])
                    }, {
                        method: 'POST',
                        ignoredErrorCodes: [ERROR_CONFLICT]
                    }
                ));
            };

            additionalWork.push(seisoRequest(
                self,
                'ipAddressRoles/', {
                    name: 'default',
                    description: 'Default role',
                    serviceInstance: serviceInstanceLink
                }, {
                    method: 'POST',
                    ignoredErrorCodes: [ERROR_CONFLICT]
                }
            ));

            return Promise.all(additionalWork).then(function () {
                return Promise.resolve(serviceInstance);
            });
        });
}

SeisoClient.prototype.createNodeAsync = function (nodeRequest) {
    var self = this;
    return seisoRequest(
            self,
            'nodes/', {
                name: nodeRequest.name,
                serviceInstance: nodeRequest.serviceInstanceLink,
                machine: nodeRequest.machine
            }, {
                method: 'POST'
            }
        )
        // If creation fails due to a conflict, but node exists, just return it
        .catch(function (err) {
            if (err && err.statusCode === ERROR_CONFLICT) {
                return self.findNodesAsync({
                        name: nodeRequest.name,
                        filters: [
                            {
                                type: 'Tag',
                                name: 'AWS Instance ID',
                                value: params.tags['AWS Instance ID']
        }
      ]
                    })
                    .then(function (matchingNodes) {
                        if (!matchingNodes) {
                            return Promise.reject({
                                message: 'Node creation failed with conflict but node does not exist'
                            });
                        } else if (Array.isArray(matchingNodes) && matchingNodes.length > 1) {
                            return Promise.reject({
                                message: 'Node creation failed with conflict and node retrieval found multiple matching nodes'
                            });
                        } else if (Array.isArray(matchingNodes)) {
                            return Promise.resolve(matchingNodes[0]);
                        }

                        return Promise.resolve(matchingNodes);
                    });
            }

            return Promise.reject(err);
        })
        .then(function (node) {
            return self.syncNodeIpAddressesAsync(nodeRequest.serviceInstanceId, node, nodeRequest.ipAddresses);
        });
};


SeisoClient.prototype.updateNodeAsync = function (existingNode, params) {
    var self = this;

    return seisoRequest(
            self,
            "nodes/" + getRestRecordId(existingNode), {
                name: params.name,
                serviceInstance: params.serviceInstanceLink,
                machine: params.machine
            }, {
                method: 'PUT'
            }
        )
        // If update fails due to a conflict, but node exists, just return it
        .catch(function (err) {
            if (err && err.statusCode === ERROR_CONFLICT) {
                return self.findNodesAsync({
                        name: nodeRequest.name,
                        filters: [
                            {
                                type: 'Tag',
                                name: 'AWS Instance ID',
                                value: params.tags['AWS Instance ID']
                            }
                          ]
                    })
                    .then(function (matchingNodes) {
                        if (!matchingNodes) {
                            return Promise.reject({
                                message: 'Node update failed with conflict but node does not exist'
                            });
                        } else if (Array.isArray(matchingNodes) && matchingNodes.length > 1) {
                            return Promise.reject({
                                message: 'Node update failed with conflict and node retrieval found multiple matching nodes'
                            });
                        } else if (Array.isArray(matchingNodes)) {
                            return Promise.resolve(matchingNodes[0]);
                        }

                        return Promise.resolve(matchingNodes);
                    });
            }

            return Promise.reject(err);
        })
        .then(function (node) {
            return self.syncNodeIpAddressesAsync(params.serviceInstanceId, node, params.ipAddresses);
        });
};

/**
 * Get Available Rotation Statuses
 * @returns {SeisoResponse} Rotation Statuses list
 */
SeisoClient.prototype.getRotationStatuses = function () {
    var self = this;
    return seisoRequest(
        self,
        "rotationStatuses",
        null,
        {method: 'GET'}
    );
}

/**
 * Update (via PATCH) Node Rotation Status
 * @param   {SeisoDataResource} node              Node Record
 * @param   {String} status            Status Rotated In or Out
 * @returns {Promise} Http request response promise.
 */
SeisoClient.prototype.patchNodeAggregateRotationStatus = function (node, status) {
    var self = this;
    return seisoRequest(
        self,
        "nodes/" + getRestRecordId(node),
        {
            aggregateRotationStatus: status
        },
        { method: 'PATCH' }
    );
}

SeisoClient.prototype.syncNodeIpAddressesAsync = function (serviceInstanceId, node, ipAddresses) {
    var self = this;
    return seisoRequest(
            self, ['nodes', getRestRecordId(node), 'ipAddresses'].join('/'),
            null,
            null,
            'nodeIpAddresses'
        )
        .then(function (existingIpAddresses) {
            var work = [];
            var confirmedIpAddresses = [];
            var ipAddressesToAdd = [];
            if (existingIpAddresses && Array.isArray(existingIpAddresses)) {
                for (var i = 0; i < existingIpAddresses.length; i++) {
                    if (ipAddresses.indexOf(existingIpAddresses[i].ipAddress) < 0) {
                        work.push(self.deleteNodeIpAddress(node, existingIpAddresses[i]));
                    } else {
                        confirmedIpAddresses.push(existingIpAddresses[i].ipAddress);
                    }
                };
            }
            for (var i = 0; i < ipAddresses.length; i++) {
                if (confirmedIpAddresses.indexOf(ipAddresses[i]) < 0) {
                    ipAddressesToAdd.push(ipAddresses[i]);
                }
            };

            if (ipAddressesToAdd.length > 0) {
                var getIpAddressRole = self.getDefaultIpAddressRole(serviceInstanceId);

                for (var i = 0; i < ipAddressesToAdd.length; i++) {
                    var ipAddressToAdd = ipAddressesToAdd[i];
                    work.push(getIpAddressRole.then(function (role) {
                        return self.createNodeIpAddress(node, role, ipAddressToAdd);
                    }));
                };
            }

            if (work.length > 0) {
                return Promise.all(work).then(function () {
                    return Promise.resolve(node);
                });
            }

            return Promise.resolve(node);
        });
};

SeisoClient.prototype.deleteNodeIpAddress = function (node, ipAddress) {
    var self = this;

    return seisoRequest(
        self, ['nodeIpAddresses', getRestRecordId(ipAddress)].join('/'),
        null, {
            method: 'DELETE',
            ignoredErrorCodes: [ERROR_CONFLICT]
        }
    );
};

SeisoClient.prototype.createNodeIpAddress = function (node, role, ipAddress) {
    var self = this;

    console.log('Creating ip address ' + ipAddress);
    return seisoRequest(
        self,
        'nodeIpAddresses', {
            node: getRestRecordLink(node),
            ipAddressRole: getRestRecordLink(role),
            ipAddress: ipAddress
        }, {
            method: 'POST',
            ignoredErrorCodes: [ERROR_CONFLICT]
        }
    );
}

SeisoClient.prototype.getDefaultIpAddressRole = function (serviceInstanceId) {
    var self = this;

    return seisoRequest(
            self, ['serviceInstances', serviceInstanceId, 'ipAddressRoles'].join('/'),
            null,
            null,
            'ipAddressRoles')
        .then(function (roles) {
            if (roles && Array.isArray(roles)) {
                for (var i = 0; i < roles.length; i++) {
                    if (roles[i].name === 'default') {
                        return Promise.resolve(roles[i]);
                    }
                };
            } else if (roles && roles.name === 'default') {
                // Just a single role
                return Promise.resolve(roles);
            }

            return Promise.reject({
                message: 'Unable to find default IP address role'
            });
        })
}

SeisoClient.prototype.upsertMachineAsync = function (params) {
    var self = this;
    return seisoRequest(
            self,
            "machines/search/findByName",
            null, {
                name: params.name,
                ignoredErrorCodes: [ERROR_NOT_FOUND]
            }
        )
        .then(function (machine) {
            if (machine) {
                var id = getRestRecordId(machine);
                console.log('Machine found with id ' + id + '; updating');
                return self.updateMachineAsync(id, params);
            } else {
                return self.createMachineAsync(params);
            }
        });
};

/**
 * Get LoadBalancersList
 * @resolves Array<LoadBalancer> An array of LoadBalancer records
 */
SeisoClient.prototype.getLoadBalancersAsync = function () {
    var self = this;
    return seisoRequest(
            self,
            'loadBalancers',
            null, {
                method: 'GET'
            }
        )
        .catch(function (err) {
            if (err && err.statusCode === ERROR_NOT_FOUND) {
                return Promise.reject({
                    message: '404 request for Load Balancers failed. Load balancers endpoint not found'
                });
            }
        });
}

SeisoClient.prototype.getNodesAsync = function () {
    var self = this;
    return seisoRequest(
            self,
            'nodes',
            null, {
                method: 'GET'
            }
        )
        .catch(function (err) {
            if (err && err.statusCode === ERROR_NOT_FOUND) {
                return Promise.reject({
                    message: '404 request for Load Balancers failed. Load balancers endpoint not found'
                });
            }
        });
}

/**
 * Create new machine record
 * @param Object params Machine record data
 * @return Promise Record creation promise
 */
SeisoClient.prototype.createMachineAsync = function (params) {
    var self = this;
    return seisoRequest(
            self,
            'machines/',
            params, {
                method: 'POST'
            }
        )
        // If a conflict occurs, try to find and return machine
        .catch(function (err) {
            if (err && err.statusCode === ERROR_CONFLICT) {
                return self.getMachinesByNameAsync(params.name)
                    .then(function (matchingMachines) {
                        if (!matchingMachines) {
                            return Promise.reject({
                                message: 'Machine creation failed with conflict but machine does not exist'
                            });
                        } else if (Array.isArray(matchingMachines) && matchingMachines.length > 1) {
                            return Promise.reject({
                                message: 'Machine creation failed with conflict and machine retrieval found multiple matching machines'
                            });
                        } else if (Array.isArray(matchingMachines)) {
                            return Promise.resolve(matchingMachines[0]);
                        }

                        return Promise.resolve(matchingMachines);
                    });
            }

            return Promise.reject(err);
        });
}

SeisoClient.prototype.updateMachineAsync = function (id, params) {
    var self = this;
    return seisoRequest(
            self,
            'machines/' + id,
            params, {
                method: 'PUT'
            }
        )
        // If a conflict occurs, try to find and return machine
        .catch(function (err) {
            if (err && err.statusCode === ERROR_CONFLICT) {
                return self.getMachinesByNameAsync(params.name)
                    .then(function (matchingMachines) {
                        if (!matchingMachines) {
                            return Promise.reject({
                                message: 'Machine update failed with conflict but machine does not exist'
                            });
                        } else if (Array.isArray(matchingMachines) && matchingMachines.length > 1) {
                            return Promise.reject({
                                message: 'Machine update failed with conflict and machine retrieval found multiple matching machines'
                            });
                        } else if (Array.isArray(matchingMachines)) {
                            return Promise.resolve(matchingMachines[0]);
                        }

                        return Promise.resolve(matchingMachines);
                    });
            }

            return Promise.reject(err);
        });
}

/**
 * Parse Seiso Resource Record Response for id
 * @param {SeisoData} record Seiso API rest response: one record
 */
function getRestRecordId(record) {
    return getRestRecordLink(record).split('/').pop();
}

function getRestRecordLink(record) {
    return record._links.self.href;
}

/**
 * Format a Seiso API request
 * @param Object conn Seiso Connection Configuration
 * @param resource String Resource Request
 */
function genAPIReq(conn, resource) {
    var password = endecoder.convert64ToStr(conn.password);
    var auth = "Basic " + new Buffer(conn.username + ":" + password).toString("base64");
    var url = [conn.url, resource].join('/');

    return {
        url: url,
        rejectUnauthorized: conn.rejectUnauthorized,
        method: 'GET',
        resolveWithFullResponse: true,
        headers: {
            Authorization: auth
        }
    }
}

/**
 * API Request to Seiso
 * @param {object}   request  Request package data. Headers and content.
 * @param {string} resource Seiso resource type name.
 * @param {object}   opts     Request parameters.
 */
function seisoRequest(seisoClient, resource, payload, opts, embeddedResourceName) {
    var key;
    var actualOpts = {};
    resource = resource || ""; // Allow Null or empty for 'Connect' attempt
    var method = (opts && opts.method) ? opts.method : 'GET';
    embeddedResourceName = embeddedResourceName || resource;

    // Validate any client-specific options
    if (opts && opts.ignoredErrorCodes && !Array.isArray(opts.ignoredErrorCodes)) {
        throw new Error('Ignored error codes must be an array of status codes');
    }

    // Set up defaults for page and size on GET
    if (method === 'GET') {
        actualOpts.size = 500;
        actualOpts.page = 1;
    }

    // Pass options on to request
    for (key in opts) {
        // Skip client-specific options
        if (key === 'method' || key === 'ignoredErrorCodes') {
            continue;
        }
        actualOpts[key] = opts[key];
    }
    if (actualOpts.page) {
        actualOpts.page -= 1; // Since paging starts from ZERO
    }

    var kv_pairs = []; // Build and format our key value pairs for request
    for (key in actualOpts) {
        if (actualOpts[key] === undefined) {
            continue;
        }
        kv_pairs.push(key + "=" + actualOpts[key]);
    }
    console.log("context of request", resource);
    var item_collection, seiso_request = genAPIReq(seisoClient, resource);

    if (kv_pairs.length > 0) {
        seiso_request.url += "?" + kv_pairs.join("&");;
    }

    seiso_request.method = method;

    if (payload) {
        seiso_request.body = payload;
        seiso_request.json = true;
    }
    console.log("calling seiso api", seiso_request);
    return requestAsync(seiso_request)
        .catch(function (err) {
            if (opts && err && opts.ignoredErrorCodes && opts.ignoredErrorCodes.indexOf(err.statusCode) > -1) {
                return Promise.resolve(null);
            }
            return Promise.reject(err);
        })
        .then(function (response) {
            var data;
            if (response) {
                data = response.body;
                if (typeof data === 'string') {
                    if (data.length > 0) {
                        data = JSON.parse(data);
                    } else {
                        data = null;
                    }
                }
            }
            return Promise.resolve(data);
        })
        .then(function (data) {
            if (data && resource && data["_embedded"]) {
                item_collection = data["_embedded"][embeddedResourceName];
                var page_count = data["page"] ? data["page"]["totalPages"] : 1;
                page_count = page_count ? page_count : 1;
                return Promise.resolve(item_collection);
            } else {
                return Promise.resolve(data);
            }
        });
}

function preCacheDomainData(seisoClient) {
    // Load environments and data centers
    var loadEnvironments = seisoRequest(
        seisoClient,
        'environments',
        null,
        null
    );

    var loadDataCenters = seisoRequest(
        seisoClient,
        'dataCenters',
        null,
        null
    );

    return Promise.join(loadEnvironments, loadDataCenters, function (environments, dataCenters) {
        seisoClient.environments = {};
        console.log('Found ' + environments.length + ' environment(s) and ' + dataCenters.length + ' data center(s)');
        for (var i = 0; i < environments.length; i++) {
            seisoClient.environments[environments[i].key] = environments[i];
        };

        seisoClient.dataCenters = {};
        for (var i = 0; i < dataCenters.length; i++) {
            seisoClient.dataCenters[dataCenters[i].key] = dataCenters[i];
        };

        return Promise.resolve(null);
    });
}
