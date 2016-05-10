'use strict';
/**
 * Convert Strings to Base64 or Base64 back to ascii string
 */
var convertStrTo64 = exports.convertStrTo64 = function convertStrTo64( ascii ) {
    return (new Buffer(ascii)).toString('base64');
}
var convert64ToStr = exports.convert64ToStr = function convert64ToStr( base64 ) {
    return (new Buffer(base64, 'base64')).toString();
}