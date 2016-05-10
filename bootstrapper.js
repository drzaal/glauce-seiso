'use strict';

var AWS = require('aws-sdk');
var Promise = require('bluebird');

var exports = module.exports = {
    execute: BootstrapHealthstateAws
};

/**
 * Bootstrap/setup the Seiso Rotation Status listener
 * 1. Create a subscription queue for rotation events
 * 2. Create and configure the Status Check Failed event
 * 3. Create a cloud watch rule which assigns  Status Check Failed event
 * 4. Create a listener queue to subscribe to the SNS topic
 * 5. Grant rw permissions on listener queue from subscription queue
 * 6. grant listener permissions on sqs queue
 * 7. Subscribe the topics
 */

var validationErrors = [];
var sns, sqs, cwe, elb, ec2;
var config;

/**
 * Bootstrap Rotation Status Listener on startup
 * @param {Object} bootConfig Configuration parameters
 *                            region
 *                            bootstrapperCredentials: {accessKeyId,
 *                            secretAccessKey}
 *                            topicArn
 *                            topicName
 *                            queueUrl
 *                            queuePrefix
 *                            queueName
 * @param {Function} callback   Notify on bootstrap complete
 */
function BootstrapHealthstateAws(bootConfig, callback) {
    validationErrors = [];
    config = Object.freeze(bootConfig); // Make conf immutable, to protect against sideeffects

    console.log("bootstrap config", config) // DON'T BOOTSTRAP YET
    return;

    if (!validateConfig(config)) {
        var err = new Error("Config not valid:\n" + validationErrors.join("\n"));
        if (callback && callback instanceof Function) {
            process.nextTick(function () {
                callback(err);
            });
            return;
        } else {
            throw err;
        }
    }

    configAWS(config);
    defineAsyncConnectors(); // Assigns sns,sqs,cwe,elb,ec2

    var topicResolution = createTopic();

    var queueResolution = topicResolution
        .then(createStatusAlarm)
        .then(createCWRule)
        .then(createQueue);

    var permissionGranted = Promise.join(topicResolution, queueResolution, grantOnTopic);
    var queueSubscribed = Promise.join(topicResolution, queueResolution, subscribe);

    Promise.all([permissionGranted, queueSubscribed])
        .then(function () {
            if (callback && callback instanceof Function) {
                process.nextTick(function () {
                    callback();
                });
            }
        })
        .catch(function (err) {
            err = new Error("Bootstrap failure:\n" + validationErrors.join("\n"));
            if (callback && callback instanceof Function) {
                process.nextTick(function () {
                    callback(err);
                });
                return;
            } else {
                throw err;
            }
        });
}

function configAWS(config) {
    AWS.config.update({
        region: config.region
    });

    var creds = config.bootstrapperCredentials || config.listenerCredentials;
    AWS.config.update({
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey
    });
}

/*
 * Map Async connectors
 * Function has side effects
 */
function defineAsyncConnectors() {
    sns = new AWS.SNS();
    sqs = new AWS.SQS();
    cwe = new AWS.CWE();
    elb = new AWS.ELB();
    ec2 = new AWS.EC2();

    var wrap = Promise.promisify;

    sns.createTopicAsync = wrap(sns.createTopic);
    sns.subscribeAsync = wrap(sns.subscribe);
    sns.addPermissionAsync = wrap(sns.add);
    sns.getTopicAttributesAsync = wrap(sns.getTopicAttributes);
    sns.setTopicAttributesAsync = wrap(sns.setTopicAttributes);

    sqs.createQueueAsync = wrap(sqs.createQueue);
    sqs.getQueueAttributesAsync = wrap(sqs.getQueueAttributes);
    sqs.setQueueAttributesAsync = wrap(sqs.setQueueAttributes);
    sqs.addPermissionAsync = wrap(sqs.addPermission);

    cwe.putRuleAsync = wrap(cwe.putRuleAsync);
    cwe.putTargetsAsync = wrap(cwe.putTargets);
}

/**
 * Create a new Topic
 */
function createTopic() {

    if (config.topicArn) {
        console.log("Topic already exists");
        return Promise.resolve(config.topicArn);
    } else {
        console.log("Creating topic");

        return sns.createTopicAsync({
                Name: config.topicName || "ec2-instance-health-status-failure"
            })
            .then(function (data) {
                console.log("Topic created: ", data);
                return (data.TopicArn);
            });
    }
}

/*
 * Create a Status Alarm
 * Status alarm triggers on instance with a failed ELB healthcheck
 * Note
 * If you are using an AWS Identity and Access Management (IAM) account to create or modify an alarm, you must have the following Amazon EC2 permissions:
 * ec2:DescribeInstanceStatus and ec2:DescribeInstances for all alarms on Amazon EC2 instance status metrics.
 * ec2:StopInstances for alarms with stop actions.
 * ec2:TerminateInstances for alarms with terminate actions.
 * ec2:DescribeInstanceRecoveryAttribute, and ec2:RecoverInstances for alarms with recover actions.
 */
function createStatusAlarm(topicArn) {
    var alarmParams = {
        AlarmName: "seiso-ec2-instance-health-status-change",
        CompariconOperator: "GreaterThanThreshold",
        EvaluationPeriods: 0,
        MetricName: 'StatusCheckFailed',
        Namespace: 'AWS/EC2',
        Period: 0,
        Statistic: 'Sum',
        Threshold: 0.0,
        ActionsEnabled: true,
        AlarmActions: [topicArn],
        AlarmDescription: "Seiso Rotation State Health Alarm",
        Dimensions: [{
            Name: 'InstanceId',
            Value: '*'
        }],
        Unit: 'Count'
    };
    return cw.putMetricAlarm(alarmParams)
}

/*
 * Create a Health Check Failed Alarm
 * Status alarm triggers on instance with a failed ELB healthcheck
 * Note
 * If you are using an AWS Identity and Access Management (IAM) account to create or modify an alarm, you must have the following Amazon EC2 permissions:
 * ec2:DescribeInstanceStatus and ec2:DescribeInstances for all alarms on Amazon EC2 instance status metrics.
 * ec2:StopInstances for alarms with stop actions.
 * ec2:TerminateInstances for alarms with terminate actions.
 * ec2:DescribeInstanceRecoveryAttribute, and ec2:RecoverInstances for alarms with recover actions.
 */
function createHealthAlarm(topicArn) {
    var alarmParams = {
        AlarmName: "seiso-ec2-elb-health-status-alarm",
        CompariconOperator: "GreaterThanThreshold",
        EvaluationPeriods: 0,
        MetricName: 'StatusCheckFailed',
        Namespace: 'AWS/EC2',
        Period: 0,
        Statistic: 'Sum',
        Threshold: 0.0,
        ActionsEnabled: true,
        AlarmActions: [topicArn],
        AlarmDescription: "Seiso Rotation State Health Alarm",
        Dimensions: [{
            Name: 'LoadBalancerName',
            Value: '*'
        }],
        Unit: 'Count'
    };
    // Have to do all the loadbalancers. this another instance that it's wise 
    // to chunk my requests?
    return cw.putMetricAlarm(alarmParams)
}

/*
 * Create a CloudWatch Rule to apply the Alarm
 */
function createCWRule(topicArn) {
    var eventPattern = {
        "detail-type": [
        "AWS API Call via CloudTrail"
      ],
        "detail": {
            "eventSource": [
          "elasticloadbalancing.amazonaws.com"
        ],
            "eventName": [
          "RegisterInstancesWithLoadBalancer",
          "DeregisterInstancesWithLoadBalancer"
        ]
        }
    };
    var ruleName = "seiso-ec2-instance-health-status-failure";
    return cwe.putRuleAsync({
            Name: ruleName,
            Description: "Watches for rotation state changes for AWS instances, for relay to Seeiso",
            EventPattern: JSON.stringify(eventPattern)
        })
        .then(() => cwe.putTargetsAsync({ // Assign Topic as rule target
            Rule: ruleName,
            Targets: [
                {
                    Arn: topicArn,
                    Id: 'default'
            }
        ]
        }))
        .then(data => { // Configure Policy settings
            if (data.FailedEntries && data.FailedEntries.length > 0) {
                return Promise.reject(data.FailedEntries[0]);
            }
            console.log("Configuring SNS topic policy");

            return sns.getTopicAttributesAsync({
                TopicArn: topicArn
            });
        })
        .then(function (data) {
            var eventPublishingStatement = {
                'Effect': 'Allow',
                'Action': 'sns:Publish',
                'Resource': topicArn,
                'Principal': {
                    'Service': 'events.amazonaws.com'
                },
                'Sid': 'TrustCWEToPublishEventsToMyTopic'
            };

            var policy = JSON.parse(data.Attributes.Policy);
            if (!policy.Statement ||
                !Array.isArray(policy.Statement) ||
                !policy.Statement.some(function (statement) {
                    return statement.Sid === 'TrustCWEToPublishEventsToMyTopic';
                })) {
                console.log('Creating policy statement for event publishing');
                policy.Statement = policy.Statement || [];
                policy.Statement.push(eventPublishingStatement);
                return sns.setTopicAttributesAsync({
                    TopicArn: topicArn,
                    AttributeName: 'Policy',
                    AttributeValue: JSON.stringify(policy)
                });
            } else {
                return;
            }
        });

}

/*
 * Create an SQS queue to handle notifications routing
 */
function createQueue() {
    // Set up SQS queue creation, if it wasn't passed in
    var createQueueIfRequired;
    if (config.queueUrl) {
        console.log('Queue already exists');
        createQueueIfRequired = Promise.resolve(config.queueUrl);
    } else {
        var queueName = getQueueName(config);
        console.log('Queue ' + queueName + ' will be created');

        createQueueIfRequired = sqs.createQueueAsync({
                QueueName: queueName
            })
            .then(function (data) {
                console.log('Queue created: ', data);
                return data.QueueUrl;
            });
    }

    // Set up SQS Queue ARN retrieval
    return createQueueIfRequired
        .then(function (queueUrl) {
            console.log('Retrieving queue ARN');
            return sqs.getQueueAttributesAsync({
                    QueueUrl: queueUrl,
                    AttributeNames: ['QueueArn']
                })
                .then(function (data) {
                    console.log('Retrieved queue ARN ' + data.Attributes.QueueArn + ' for queue URL ' + queueUrl);
                    return {
                        url: queueUrl,
                        arn: data.Attributes.QueueArn
                    };
                });
        });
}

/*
 * Apply permissions from the Queue to the Topic
 */
function grantOnTopic(topicArn, queueIdentifiers) {
    // Set up SQS permissions, if needed
    console.log('Creating topic permissions to write to queue');
    var policy = {
        'Version': '2012-10-17',
        'Id': queueIdentifiers.arn + '/SQSDefaultPolicy',
        'Statement': [{
            'Sid': 'Sid' + new Date().getTime(),
            'Effect': 'Allow',
            'Principal': {
                'AWS': '*'
            },
            'Action': 'SQS:SendMessage',
            'Resource': queueIdentifiers.arn,
            'Condition': {
                'ArnEquals': {
                    'aws:SourceArn': topicArn
                }
            }
        }]
    };

    // Set up listener permissions to consume processing queue
    if (!config.bootstrapperCredentials) {
        console.log('Not setting up listener permissions; listener owns queue');
    } else {
        console.log('Listener permissions will be configured');
        policy.Statement.push({
            'Sid': 'Sid' + (new Date().getTime() + 1),
            'Effect': 'Allow',
            'Principal': {
                'AWS': config.listenerCredentials.arn,
            },
            'Action': [
                'SQS:ReceiveMessage',
                'SQS:DeleteMessage'
            ],
            'Resource': queueIdentifiers.arn
        });
    }

    return sqs.setQueueAttributesAsync({
        QueueUrl: queueIdentifiers.url,
        Attributes: {
            'Policy': JSON.stringify(policy)
        }
    });
}

/*
 * Grant app permissions to read/delete from the Queue
 */
function grantOnQueue() {}

/*
 * Subscribe the Queue to the Topic
 */
function subscribe(topicArn, queueIdentifiers) {
    // Set up queue subscription to topic
    console.log('Adding topic subscription');
    return sns.subscribeAsync({
        TopicArn: topicArn,
        Protocol: 'sqs',
        Endpoint: queueIdentifiers.arn
    });
}

function validateConfig(config) {
    var failure = validationErrors.push;
    if (!config) {
        failure('Config missing but required');
        return false;
    }

    if (!config.creds) {
        failure("Listener/Feeder Credentials not provided");
    }

    if (!config.arn) {
        failure("Credentials incomplete");
    }

    return (validationErrors.length === 0);
}

/*
 * Generate a Queue name if necessary and appropriate
 */
function getQueueName(config) {
    var queueName; // Default is "seiso-ec2-instance-event-processing"

    // Re-use from config, if specified
    if (config.queueName) {
        queueName = config.queueName;

        // Add queue prefix if not present
        if (config.queuePrefix && queueName.slice(config.queuePrefix.length) !== config.queuePrefix) {
            // Offset name from prefix if needed
            if (config.queuePrefix.slice(-1) !== '-' &&
                config.queuePrefix.slice(-1) !== '_' &&
                queueName.slice(-1) !== '-' &&
                queueName.slice(-1) !== '_') {
                queueName = '-' + queueName;
            }

            queueName = config.queuePrefix + queueName;
        }
    } else {
        queueName = 'ec2-instance-event-processing';
        if (config.queuePrefix) {
            // Prepend "seiso-" if not somewhere in the prefix to designate this as used exclusively by/for seiso
            if (config.queuePrefix.indexOf('seiso') === -1) {
                queueName = ['seiso', queueName].join('-');
            }

            // Offset name from prefix if needed
            if (config.queuePrefix.slice(-1) !== '-' && config.queuePrefix.slice(-1) !== '_') {
                queueName = '-' + queueName;
            }

            queueName = config.queuePrefix + queueName;
        } else {
            queueName = ['seiso', queueName].join('-');
        }
    }

    return queueName;
}
console.log("is this running bootstrapper?")
