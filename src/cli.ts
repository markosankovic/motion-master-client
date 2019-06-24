#!/usr/bin/env node

import program, { Command } from 'commander';
import * as rxjs from 'rxjs';
import { filter, first } from 'rxjs/operators';
import * as util from 'util';
import { v4 } from 'uuid';
import * as zmq from 'zeromq';
import { decodeMotionMasterMessage, MotionMasterClient } from './motion-master-client';

// tslint:disable: no-var-requires
const debug = require('debug')('motion-master-client');
const version = require('../package.json')['version'];
// tslint:enable-next-line: no-var-requires

const inspectOptions: util.InspectOptions = {
  showHidden: false,
  depth: null,
  colors: true,
  maxArrayLength: null,
};

const cliOptions = {
  pingSystemInterval: 250,
  serverEndpoint: 'tcp://127.0.0.1:62524',
  notificationEndpoint: 'tcp://127.0.0.1:62525',
};

const pingSystemInterval = rxjs.interval(cliOptions.pingSystemInterval);

const identity = v4();
debug(`Identity: ${identity}`);

const serverSocket = zmq.socket('dealer');
serverSocket.identity = identity;
serverSocket.connect(cliOptions.serverEndpoint);
debug(`ZeroMQ DEALER socket is connected to server endpoint: ${cliOptions.serverEndpoint}`);

const notificationSocket = zmq.socket('sub').connect(cliOptions.notificationEndpoint);
debug(`ZeroMQ SUB socket connected to notification endpoint: ${cliOptions.notificationEndpoint}`);

notificationSocket.subscribe('');

process.on('uncaughtException', (err) => {
  console.error('Caught exception: ' + err);
  process.exit();
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection reason: ', reason);
  process.exit();
});

const input = new rxjs.Subject<Buffer>();
const output = new rxjs.Subject<Buffer>();
const notification = new rxjs.Subject<[Buffer, Buffer]>();

// feed notification buffer data coming from Motion Master to MotionMasterClient
notificationSocket.on('message', (topic: Buffer, message: Buffer) => {
  notification.next([topic, message]);
});

const motionMasterClient = new MotionMasterClient(input, output, notification);

pingSystemInterval.subscribe(() => motionMasterClient.requestPingSystem());

// feed buffer data coming from Motion Master to MotionMasterClient
serverSocket.on('message', (data) => {
  input.next(data);
});

// send buffer data fed from MotionMasterClient to Motion Master
output.subscribe((buffer) => {
  const message = decodeMotionMasterMessage(buffer);
  // log outgoing messages and skip ping messages
  if (!(message && message.request && message.request.pingSystem)) {
    debug(
      util.inspect(decodeMotionMasterMessage(buffer).toJSON(), inspectOptions),
    );
  }
  serverSocket.send(buffer);
});

// log all status messages coming from Motion Master
motionMasterClient.motionMasterMessage$.subscribe((msg) => {
  const timestamp = Date.now();
  const message = msg.toJSON();
  console.log(
    util.inspect({ timestamp, message }, inspectOptions),
  );
});

program
  .version(version);

program
  .command('request <type> [args...]')
  .option('-d, --device-address <value>', 'device address (uint32) generated by Motion Master - takes precedence over device position', parseOptionValueAsInt)
  .option('-p, --device-position <value>', 'used when device address is not specified', parseOptionValueAsInt, 0)
  .action(async (type: string, args: string[], cmd: Command) => {
    const deviceAddress = await getCommandDeviceAddress(cmd);
    const messageId = v4();
    exitOnMessageReceived(messageId);
    switch (type) {
      case 'GetSystemVersion':
        motionMasterClient.requestGetSystemVersion(messageId);
        break;
      case 'GetDeviceInfo':
        motionMasterClient.requestGetDeviceInfo(messageId);
        break;
      case 'GetDeviceParameterInfo':
        motionMasterClient.requestGetDeviceParameterInfo(deviceAddress, messageId);
        break;
      case 'GetDeviceParameterValues':
        const parameters = args.map(paramToIndexAndSubindex);
        motionMasterClient.requestGetDeviceParameterValues(deviceAddress, parameters, messageId);
        break;
      case 'GetDeviceFileList':
        motionMasterClient.requestGetDeviceFileList(deviceAddress);
        break;
      case 'GetDeviceLog':
        motionMasterClient.requestGetDeviceLog(deviceAddress);
        break;
      default:
        throw new Error(`Request "${program.request}" doesn\'t exist`);
    }
  });

program
  .command('upload [params...]')
  .option('-d, --device-address <value>', 'device address (uint32) generated by Motion Master - takes precedence over device position', parseOptionValueAsInt)
  .option('-p, --device-position <value>', 'used when device address is not specified', parseOptionValueAsInt, 0)
  .action(async (params: string[], cmd: Command) => {
    const deviceAddress = await getCommandDeviceAddress(cmd);
    const parameters = params.map(paramToIndexAndSubindex);
    const messageId = v4();
    exitOnMessageReceived(messageId);
    motionMasterClient.requestGetDeviceParameterValues(deviceAddress, parameters, messageId);
  });

program
  .command('download [paramValues...]')
  .option('-d, --device-address <value>', 'device address (uint32) generated by Motion Master - takes precedence over device position', parseOptionValueAsInt)
  .option('-p, --device-position <value>', 'used when device address is not specified', parseOptionValueAsInt, 0)
  .action(async (paramValues: string[], cmd: Command) => {
    const deviceAddress = await getCommandDeviceAddress(cmd);
    const parameters = paramValues.map(paramValueToIndexAndSubindex);
    const messageId = v4();
    exitOnMessageReceived(messageId);
    motionMasterClient.requestSetDeviceParameterValues(deviceAddress, parameters, messageId);
  });

program
  .command('monitor <topic> [params...]')
  .option('-d, --device-address <value>', 'device address (uint32) generated by Motion Master - takes precedence over device position', parseOptionValueAsInt)
  .option('-p, --device-position <value>', 'used when device address is not specified', parseOptionValueAsInt, 0)
  .option('-i, --interval <value>', 'sending interval in microseconds', parseOptionValueAsInt, 1 * 1000 * 1000)
  .action(async (topic: string, params: string[], cmd: Command) => {
    const deviceAddress = await getCommandDeviceAddress(cmd);
    motionMasterClient.filterNotificationByTopic$(topic).subscribe((notif) => {
      const timestamp = Date.now();
      const message = notif.message;
      console.log(
        util.inspect({ timestamp, topic, message }, inspectOptions),
      );
    });
    const interval = cmd.interval;
    const parameters = params.map(paramToIndexAndSubindex);
    motionMasterClient.startMonitoringDeviceParameterValues(interval, topic, { parameters, deviceAddress });
  });

program.parse(process.argv);

function paramToIndexAndSubindex(param: string) {
  const [indexStr, subindexStr] = param.split(':');
  const index = parseInt(indexStr, 16);
  const subindex = parseInt(subindexStr, 10);
  return { index, subindex };
}

function paramValueToIndexAndSubindex(paramValue: string) {
  const [param, valueStr] = paramValue.split('=');
  const { index, subindex } = paramToIndexAndSubindex(param);
  const value = parseFloat(valueStr);
  const intValue = value;
  const uintValue = value;
  const floatValue = value;
  return { index, subindex, intValue, uintValue, floatValue };
}

async function getCommandDeviceAddress(command: Command) {
  if (command.deviceAddress) {
    return command.deviceAddress;
  } else if (Number.isInteger(command.devicePosition)) {
    const device = await motionMasterClient.getDeviceAtPosition$(command.devicePosition).toPromise();
    if (device) {
      return device.deviceAddress;
    } else {
      throw new Error(`There is no device at position ${command.devicePosition}`);
    }
  }
}

function exitOnMessageReceived(messageId: string, exit: boolean = true) {
  motionMasterClient.motionMasterMessage$.pipe(
    filter((message) => message.id === messageId),
    first(),
  ).subscribe(() => {
    if (exit) {
      process.exit();
    }
  });
}

function parseOptionValueAsInt(value: string) {
  return parseInt(value, 10);
}
