Seiso Rotation State Listener for AWS
NPM module for an application which listens to AWS load balancer register/deregister events and patches this data to Seiso nodes to provide up to date rotation states.


Currently application is capable or providing rotation states. Application does not support multiple concurrent Seiso Instances.

Stand a different instance for each Seiso Instance, and send CloudWatch API LB events to different queues based on the Environment and Datacenter as appropriate.

Bootstrap needs work. There is a bunch of CloudTrail setup necessary to get this working. Could be we are assuming that Cloud Trail is configured and permissioned to send API events to cloudwatch already.

Check test/index for basic use.
