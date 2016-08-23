// Copyright 2015, EMC, Inc.
// jshint bitwise: false

// Javascript port of the ipmitool sensors parser from
// http://docs.openstack.org/developer/ironic/
//   _modules/ironic/drivers/modules/ipmitool.html

"use strict";

var di = require('di');

module.exports = parseSensorsDataFactory;
di.annotate(parseSensorsDataFactory, new di.Provide('JobUtils.IpmiCommandParser'));
di.annotate(parseSensorsDataFactory, new di.Inject('Assert', '_'));
function parseSensorsDataFactory(assert, _) {
    //UID status code, 0 = Off, 1 = Temporary On , 2 = On, 3 = reserved
    var uidStatus = ['Off', 'Temporary On', 'On', 'Reserved'];

    function parseSelInformationData(selData) {
        var lines = selData.trim().split('\n');
        lines.shift();
        return _.transform(lines, function(result, line) {
            var split = line.split(' : ');
            result[split.shift().trim()] = split.shift().trim();
        }, {});
    }

    function parseSelData(selData) {
        if (_.isEmpty(selData)) {
            return;
        }
        assert.string(selData);
        var lines = selData.trim().split('\n');
        var sel = [];
        var PropertyValue = [];
        var previousPropertyValue = [];
        var currentEntry = {};
        
        for (var i = 0; i < lines.length; i+=1) {

            if ( (_.startsWith(lines[i],"SEL Record " )) && (i > 1) || (i === lines.length-1) ){
                sel.push(_.assign({},currentEntry));
                _.assign(currentEntry,{});
                currentEntry = new Object;
            }
            if ( !( (lines[i] === "") || (_.startsWith(lines[i],"-----" ))) ){
                PropertyValue = lines[i].split(' : ');
                PropertyValue [0] = _.trim(PropertyValue[0]);
                if(PropertyValue.length > 1){
                    currentEntry[PropertyValue[0]] = PropertyValue [1];
                    previousPropertyValue = PropertyValue;
                    PropertyValue = [];
                }
                else if (PropertyValue.length = 1){
                    currentEntry [previousPropertyValue [0]] =  previousPropertyValue [1]  + PropertyValue[0]
                }
            }
        };
        
        return sel;
    }

    /**
     * parse/extract text output from IPMI call into key/value data for the SDR
     * information
     *
     * @param sdrData
     * @returns {*}
     */
    function parseSdrData(sdrData) {
        var sdrArray = sdrData.split('\n\n');

        var sdrObjArray = _.transform(sdrArray, function(result, sdr) {
            var lines = sdr.trim().split('\n');
            var key = '';
            var value = '';
            var sdrObj = {
                sensorId: "",
                entityId: "",
                entryIdName: "",
                sdrType: "",
                sensorType: "",
                sensorReading: "",
                sensorReadingUnits: "",
                nominalReading: "",
                normalMinimum: "",
                normalMaximum: "",
                statesAsserted: []
            };

            // The value associated with these keys is a list
            var listKeys = [
                'statesAsserted',
                'assertionsEnabled',
                'deassertionsEnabled'
            ];

            // Expect all of these keys to have non-empty values.
            var requiredKeys = [
                'sensorId',
                'entityId',
                'sdrType',
                'sensorType',
                'sensorReading'
            ];

            _.forEach(lines, function(line) {
                if (line.search(':') >= 0) {
                    key = _.camelCase(line.split(':')[0]);
                    value = line.split(':')[1].trim();

                    // The sensorType key requires a bit of additional processing.  Converting
                    // to camelCase will yield 'sensorTypeDiscrete' or 'sensorTypeThreshold'
                    // We want to add an additional sdrType key with a value of Discrete or
                    // Threshold and change the key from sensorTypeXxx to sensorType.
                    if (key.search(/sensorType/) >= 0) {
                        var sensorTypeKey = key.slice(0, 'sensorType'.length);
                        var sdrTypeValue = key.slice('sensorType'.length, key.length);
                        key = sensorTypeKey;
                        value = value.match(/(.+) \(0x.+\)/)[1].trim();
                        sdrObj.sdrType = sdrTypeValue;
                    }
                    // The sensorReading key requires a bit of additional processing.
                    // sensorReading also includes sensorReadingUnits value, and we need
                    // to extract from sensorReading
                    if (key.search(/sensorReading/) >= 0) {
                        key = "sensorReadingUnits";
                        var sensorReading = "";
                        if (value.split(/\)/)[1]) {
                            sensorReading = value.split(/\(/)[0];
                            value = value.split(/\)/)[1].trim();
                        }
                        else {
                            // Sensor that does not have any SensorReadingUnits, assign NA
                            sensorReading = value;
                            value = "";
                        }
                        sdrObj.sensorReading = sensorReading.trim();
                    }
                    // The entityId key requires a bit of additional processing.
                    // entityId also includes entryIdName value, and we need
                    // to extract from entityId.
                    if (key.search(/entityId/) >= 0) {
                        key = "entryIdName";
                        var entityId = value.split(/\(([^)]+)\)/)[0];
                        value = value.split(/\(([^)]+)\)/)[1];
                        sdrObj.entityId = entityId.trim();
                    }
                }
                else {
                        value = line.trim();
                }

                //ipmitool displays states as [state name] so remove the []
                value = value.replace('[', '').replace(']', '');

                if (key.length > 0) {
                    if (_.contains(listKeys, key)) {
                        //The key needs to be mapped to a list.
                        //There is a bit of ugliness here.
                        // 1. For some reason, ipmitool includes the sensor type name in
                        //    the state lists.  We'll remove it by omitting values that
                        //    match the sensor type name.
                        // 2. The first time the key is processed, its value is undefined.
                        //    Thus, we can't use .push since it isn't a list yet.  So check
                        //    if the key exists in the object first.
                        var sensorTypeName = _.has(sdrObj, 'sensorType') ? sdrObj.sensorType : null;
                        if (sensorTypeName === null  || !sensorTypeName.match(value)) {
                            if (_.has(sdrObj, key)) {
                                sdrObj[key].push(value);
                            } else {
                                sdrObj[key] = [value];
                            }
                        }
                    } else {
                        sdrObj[key] = value;
                    }
                }
            });

            // if sdrObj has a non-empty value in every required key.
            if (_.every(requiredKeys, function(key) {return _.has(sdrObj, key) && sdrObj[key];})) {
                result.push(sdrObj);
            }
        });
        return sdrObjArray;
    }

    /**
     * parse/extract text output from IPMI call into raw data for the chassis status
     *
     * @param statusData
     * @returns {uid: 'Off|Temporary On|On|Reserved', power: true|false}
     */
    function parseChassisData(statusData) {
        // sample data : 20 00 60 71 or 20 00 60
        var numStr = statusData.replace(/\s/g, '');
        assert.ok(numStr.match(/^[0-9A-Fa-f]{8}$|^[0-9A-Fa-f]{6}$/),
                  "Invalid chassis status output : " + statusData);
        var uidCode = parseInt(numStr[4], 16);
        var powerCode = parseInt(numStr[1], 16);

        // UID status need last 2 bit , so use mask 0x3(0011)
        // Power status need last bit , so use mask 0x1(0001)
        return {
            uid: uidStatus[uidCode & 0x3],
            power: (powerCode & 0x1) === 1
        };
    }

    /**
     * parse/extract text output from IPMI call into a list of drive health status
     *
     * @param {string} drive health data
     * @returns {Array} Returns a list of drive name and health status
     */
    function parseDriveHealthData(driveHealthData) {
        var lines = driveHealthData.trim().split('\n');
        var statusArr = [];
        for (var i = 0; i < lines.length; i+=1) {
            var items = lines[i].trim().split(',');
            if (items[2] !== 'ok') {
                continue;
            }
            statusArr.push({
                name: items.shift(),
                status: items.pop() || 'Not Present' //if empty means drive not present
            });
        }
        return statusArr;
    }

    return {
        parseSelInformationData: parseSelInformationData,
        parseSelData: parseSelData,
        parseSdrData: parseSdrData,
        parseChassisData: parseChassisData,
        parseDriveHealthData: parseDriveHealthData
    };
}
