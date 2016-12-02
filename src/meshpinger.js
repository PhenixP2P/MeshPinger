/**
 * Copyright 2016 PhenixP2P Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const _ = require('lodash');
const yargs = require('yargs');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');
const moment = require('moment');

function createLogsCallback(output) {
    const outputStream = fs.createWriteStream(output, {flags: 'a'});

    return function () {
        outputStream.write(moment.utc().toISOString());
        outputStream.write('\t');
        for (var i = 0; i < arguments.length; i++) {
            outputStream.write('' + arguments[i]);
            outputStream.write('\t');
        }
        outputStream.write('\n');
    };
}

function runUdpServerSocket(port, callback) {
    const server = dgram.createSocket('udp4');
    const alpha = 0.01;
    const beta = 1. - alpha;
    const incoming = {};

    server.on('error', function (err) {
        console.log('Server error:\n%s', err.stack);
        server.close();
    });

    server.on('message', function (msg, rinfo) {
        const cols = msg.toString().split('\t');
        const now = moment.utc();
        const time = moment.utc(cols[0]);
        const hostname = cols[1];
        const count = parseInt(cols[2]);
        const latency = now.diff(time, 'milliseconds');

        if (!_.has(incoming, hostname)) {
            incoming[hostname] = {
                lastTime: time,
                count: count,
                latencyEma: latency,
                latencyEmaVar: 0.
            };
            callback('first', hostname, time.toISOString(), count);
        } else {
            const record = incoming[hostname];

            if (record.count > 240 && count < 120) {
                callback('reset', hostname, time.toISOString(), count);
                record.lastTime = time;
                record.count = count;
                // http://stats.stackexchange.com/questions/111851/standard-deviation-of-an-exponentially-weighted-mean
                record.latencyEmaVar = beta * (record.latencyEmaVar + alpha * Math.pow(latency - record.latencyEma, 2));
                record.latencyEma = beta * record.latencyEma + alpha * latency;
            } else if (count < record.count) {
                callback('out-of-order', hostname, time.toISOString(), count);
            } else if (count === record.count) {
                callback('duplicate', hostname, time.toISOString(), count);
            } else if (count === record.count + 1) {
                const delta = time.diff(record.lastTime, 'milliseconds');

                if (delta > 2000) {
                    callback('delayed', hostname, time.toISOString(), count, delta, record.lastTime.toISOString());
                }

                record.lastTime = time;
                record.count = count;
                // http://stats.stackexchange.com/questions/111851/standard-deviation-of-an-exponentially-weighted-mean
                record.latencyEmaVar = beta * (record.latencyEmaVar + alpha * Math.pow(latency - record.latencyEma, 2));
                record.latencyEma = beta * record.latencyEma + alpha * latency;
            } else {
                const missing = count - record.count - 1;

                callback('missing', hostname, time.toISOString(), count, missing, record.lastTime.toISOString());

                record.lastTime = time;
                record.count = count;
                // http://stats.stackexchange.com/questions/111851/standard-deviation-of-an-exponentially-weighted-mean
                record.latencyEmaVar = beta * (record.latencyEmaVar + alpha * Math.pow(latency - record.latencyEma, 2));
                record.latencyEma = beta * record.latencyEma + alpha * latency;
            }

            if (count % 120 === 0) {
                callback('latency', hostname, time.toISOString(), count, record.latencyEma, record.latencyEmaVar, Math.sqrt(record.latencyEmaVar));
            }
        }
    });

    server.on('listening', function () {
        const address = server.address();
        console.log('Server listening %s:%d', address.address, address.port);

        callback('listening', address.address, address.port);
    });

    server.bind(port);
}

function runPinger(endpoint, interval, callback) {
    console.log('Run pinger to end point %s with interval of %d ms', endpoint, interval);

    const address = _.get(endpoint.split(':'), '[0]', 'localhost');
    const port = parseInt(_.get(endpoint.split(':'), '[1]', 25000));
    const client = dgram.createSocket('udp4');
    const hostname = os.hostname();
    var count = 0;

    setInterval(function () {
        const msg = moment.utc().toISOString() + '\t' + hostname + '\t' + count++;

        client.send(new Buffer(msg), 0, msg.length, port, address, function (err) {
            if (err) {
                callback('send-failed', endpoint);
            }
        });
    }, interval);
}

yargs
    .usage('$0 <cmd> [args]')
    .command('mesh-ping [port] [endpoints] [log]', 'Ping end points', {
        endpoints: {
            default: 'endpoints.list'
        },
        interval: {
            default: 500
        },
        port: {
            default: 25000
        },
        log: {
            default: 'pinger.log'
        }
    }, function (argv) {
        const logCallback = createLogsCallback(argv.log);
        const endpoints = _.filter(fs.readFileSync(argv.endpoints).toString().split(/[\r\n]/), function (val) { return _.trim(val); });

        runUdpServerSocket(argv.port, logCallback);

        endpoints.forEach(function (endpoint) {
            runPinger(endpoint, argv.interval, logCallback);
        });
    }).help().argv;
