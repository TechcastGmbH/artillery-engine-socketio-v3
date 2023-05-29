/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const async = require('async');
const _ = require('lodash');

const io = require('socket.io-client');

const deepEqual = require('deep-equal');
const debug = require('debug')('socketio');
const engineUtil = require('artillery/core/lib/engine_util.js');
const EngineHttp = require('artillery/core/lib/engine_http.js');
const template = engineUtil.template;
module.exports = SocketIoEngine;

function SocketIoEngine(script) {
  this.config = script.config;

  this.socketioOpts = _.extend({}, this.config.socketio, _.get(this.config, 'engines.socketio-v3'));

  this.httpDelegate = new EngineHttp(script);
}

SocketIoEngine.prototype.createScenario = function(scenarioSpec, ee) {
  var self = this;
  let tasks = _.map(scenarioSpec.flow, function(rs) {
    if (rs.think) {
      return engineUtil.createThink(rs, _.get(self.config, 'defaults.think', {}));
    }
    return self.step(rs, ee);
  });

  return self.compile(tasks, scenarioSpec.flow, ee);
};

function markEndTime(ee, context, startedAt) {
  let endedAt = process.hrtime(startedAt);
  let delta = (endedAt[0] * 1e9) + endedAt[1];
  ee.emit('response', delta, 101, context._uid);
}

function isResponseRequired(spec) {
  return (spec.emit && spec.response && (spec.response.channel || spec.response.on));
}

function isAcknowledgeRequired(spec) {
  return (spec.emit && spec.acknowledge);
}

function processResponse(ee, data, response, context, callback) {
  // Do we have supplied data to validate?
  function isValid() {
    if (! Array.isArray(response.data)) {
      return deepEqual(data[0], response.data)
    }

    return deepEqual(data, response.data)
  }

  if (response.data && !isValid()) {
    debug('data is not valid:');
    debug(data);
    debug(response);

    let err = 'data is not valid';
    ee.emit('error', err);
    return callback(err, context);
  }

  // If no capture or match specified, then we consider it a success at this point...
  if (!response.capture && !response.match) {
    return callback(null, context);
  }

  // Construct the (HTTP) response...
  let fauxResponse = {body: JSON.stringify(data.length === 1 ? data[0] : data)};

  // Handle the capture or match clauses...
  engineUtil.captureOrMatch(response, fauxResponse, context, function(err, result) {
    // Were we unable to invoke captureOrMatch?
    if (err) {
      debug(data);
      ee.emit('error', err);
      return callback(err, context);
    }

    if (result !== null) {
      // Do we have any failed matches?
      let failedMatches = _.filter(result.matches, (v, k) => {
        return !v.success;
      });

      // How to handle failed matches?
      if (failedMatches.length > 0) {
        debug(failedMatches);
        // TODO: Should log the details of the match somewhere
        ee.emit('error', 'Failed match');
        return callback(new Error('Failed match'), context);
      } else {
        // Emit match events...
        // _.each(result.matches, function(v, k) {
        //   ee.emit('match', v.success, {
        //     expected: v.expected,
        //     got: v.got,
        //     expression: v.expression
        //   });
        // });

        // Populate the context with captured values
        _.each(result.captures, function(v, k) {
          context.vars[k] = v.value ? v.value : v;
        });
      }

      // Replace the base object context
      // Question: Should this be JSON object or String?
      context.vars.$ = fauxResponse.body;

      // Increment the success count...
      context._successCount++;

      return callback(null, context);
    }
  });
}

SocketIoEngine.prototype.step = function (requestSpec, ee) {
  let self = this;

  if (requestSpec.loop) {
    let steps = _.map(requestSpec.loop, function(rs) {
      if (!rs.emit && !rs.loop) {
        return self.httpDelegate.step(rs, ee);
      }
      return self.step(rs, ee);
    });

    return engineUtil.createLoopWithCount(
      requestSpec.count || -1,
      steps,
      {
        loopValue: requestSpec.loopValue,
        loopElement: requestSpec.loopElement || '$loopElement',
        overValues: requestSpec.over,
        whileTrue: self.config.processor ?
          self.config.processor[requestSpec.whileTrue] : undefined
      }
    );
  }

  let f = function(context, callback) {
    // Only process emit requests; delegate the rest to the HTTP engine (or think utility)
    if (requestSpec.think) {
      return engineUtil.createThink(requestSpec, _.get(self.config, 'defaults.think', {}));
    }
    if (!requestSpec.emit) {
      let delegateFunc = self.httpDelegate.step(requestSpec, ee);
      return delegateFunc(context, callback);
    }
    ee.emit('counter', 'engine.socketio.emit', 1);
    ee.emit('rate', 'engine.socketio.emit_rate');
    let startedAt = process.hrtime();
    let socketio = context.sockets[requestSpec.namespace] || null;

    if (!(requestSpec.emit && socketio)) {
      debug('invalid arguments');
      ee.emit('error', 'invalid arguments');
      // TODO: Provide a more helpful message
      callback(new Error('socketio: invalid arguments'));
    }

    let outgoing

    if (requestSpec.emit.channel) {
      outgoing = [
        template(requestSpec.emit.channel, context),
        template(requestSpec.emit.data, context)
      ]
    } else {
      outgoing = Array.from(requestSpec.emit).map((arg) => template(arg, context))
    }

    let endCallback = function (err, context, needEmit) {
      if (err) {
        debug(err);
      }

      if (isAcknowledgeRequired(requestSpec)) {
        let ackCallback = function (...args) {
          let response = {
            data: template(requestSpec.acknowledge.data || requestSpec.acknowledge.args, context),
            capture: template(requestSpec.acknowledge.capture, context),
            match: template(requestSpec.acknowledge.match, context)
          };
          // Make sure data, capture or match has a default json spec for parsing socketio responses
          _.each(response, function (r) {
            if (_.isPlainObject(r) && !('json' in r)) {
              r.json = '$.0'; // Default to the first callback argument
            }
          });
          // Acknowledge data can take up multiple arguments of the emit callback
          processResponse(ee, args, response, context, function (err) {
            if (!err) {
              markEndTime(ee, context, startedAt);
            }
            return callback(err, context);
          });
        }

        // Acknowledge required so add callback to emit
        if (needEmit) {
          socketio.emit(...outgoing, ackCallback);
        } else {
          ackCallback();
        }
      } else {
        // No acknowledge data is expected, so emit without a listener
        if (needEmit) {
          socketio.emit(...outgoing);
        }
        markEndTime(ee, context, startedAt);
        return callback(null, context);
      }
    }; // endCallback

    if (isResponseRequired(requestSpec)) {
      let response = {
        channel: template(requestSpec.response.channel || requestSpec.response.on, context),
        data: template(requestSpec.response.data || requestSpec.response.args , context),
        capture: template(requestSpec.response.capture, context),
        match: template(requestSpec.response.match, context)
      };
      // Listen for the socket.io response on the specified channel
      let done = false;
      socketio.once(response.channel, function receive(...args) {
        done = true;
        processResponse(ee, args, response, context, function(err) {
          if (!err) {
            markEndTime(ee, context, startedAt);
          }
          return endCallback(err, context, false);
        });
      });
      // Send the data on the specified socket.io channel
      socketio.emit(...outgoing);
      // If we don't get a response within the timeout, fire an error
      let waitTime = self.config.timeout || 10;
      waitTime *= 1000;
      setTimeout(function responseTimeout() {
        if (!done) {
          let err = 'response timeout';
          ee.emit('error', err);
          return callback(err, context);
        }
      }, waitTime);
    } else {
      endCallback(null, context, true);
    }
  };

  function preStep(context, callback){
    // Set default namespace in emit action
    requestSpec.namespace = template(requestSpec.namespace, context) || "";

    let connectionOnly = requestSpec?.connect

    // Backward compatability for the reconnect option
    if (connectionOnly === undefined) {
      connectionOnly = requestSpec.reconnect ? {} : undefined
    }

    self.loadContextSocket(requestSpec.namespace, connectionOnly, context, function(err, socket) {
      if(err) {
        debug(err);
        ee.emit('error', err.message);
        return callback(err, context);
      }

      if (connectionOnly && ! requestSpec.emit) {
        return callback(null, context);
      }

      if(requestSpec.beforeRequest && self.config.processor[requestSpec.beforeRequest]) {
        self.config.processor[requestSpec.beforeRequest](requestSpec,context,ee,function(err) {
          if(err) {
            debug(err);
            ee.emit('error', err.message);
            return callback(err, context);
          } else {
            return f(context, callback);
          }
        });
      } else {
        return f(context, callback);
      }
    });
  }

  if(requestSpec.emit || requestSpec.connect) {
    return preStep;
  } else {
    return f;
  }
};

/**
 * Loads and initialize the socket context
 *
 * @param {string} namespace
 * @param {object=} connectionOnly
 * @param {object} context
 * @param {SocketIoEngine~contextSocketCallback} cb
 *
 * @returns {*}
 */
SocketIoEngine.prototype.loadContextSocket = function(namespace, connectionOnly, context, cb) {
  if(connectionOnly) {
    // Disconnect the namespace socket
    SocketIoEngine.prototype.closeContextSockets(context, namespace);
  }

  if(!context.sockets[namespace]) {
    let target = this.config.target + namespace;
    let tls = this.config.tls || {};

    const socketioOpts = template(
      Object.assign({},this.socketioOpts, {
        // Require to force socket.io-client to set new headers on connection to different Namespace only if reconnecting
        forceNew: Boolean(connectionOnly),
        ...connectionOnly,
        // TODO: Deprecate some of this options to setup extraHeaders
        extraHeaders: {
          ...this.socketioOpts.extraHeaders,
          ...context.extraHeaders,
          ...connectionOnly?.extraHeaders
        },
      }),
      context
    );

    let options = _.extend(
      {},
      socketioOpts, // templated
      tls
    );

    if(this.socketioOpts.parser === "msgpack") {
      options["parser"] = require('socket.io-msgpack-parser');
    }

    let socket = io(target, options);
    context.sockets[namespace] = socket;

    socket.onAny(() => context.__receivedMessageCount++);

    socket.once('connect', function() {
      cb(null, socket);
    });
    socket.once('connect_error', function(err) {
      cb(err, null);
    });
  } else {
    return cb(null, context.sockets[namespace]);
  }
};

SocketIoEngine.prototype.closeContextSockets = function (context, namespace) {
  if (namespace !== undefined) {
    // Close the connection for the given namespace
    if (context.sockets[namespace]) {
      context.sockets[namespace].disconnect();
      delete context.sockets[namespace]
    }
  } else {
    // Close all connections
    Object.values(context.sockets).forEach(socket => socket.disconnect())
    context.sockets = {}
  }
};


SocketIoEngine.prototype.compile = function (tasks, scenarioSpec, ee) {
  let config = this.config;
  let self = this;

  function zero(callback, context) {
    context.__receivedMessageCount = 0;
    ee.emit('started');

    return callback(null, context);
  }

  return function scenario(initialContext, callback) {
    // Support for artillery v1.7+
    if (self.httpDelegate.setInitialContext) {
      initialContext = self.httpDelegate.setInitialContext(initialContext)
    } else {
      // Backwards compatability for v1.6
      initialContext._successCount = 0;
      initialContext._jar = require('./cookies').jar()
    }

    // Stores all the Socket.IO sockets
    initialContext.sockets = {}

    initialContext._pendingRequests = _.size(
      _.reject(scenarioSpec, function(rs) {
        return (typeof rs.think === 'number');
      }));

    let steps = _.flatten([
      function z(cb) {
        return zero(cb, initialContext);
      },
      tasks
    ]);

    async.waterfall(
      steps,
      function scenarioWaterfallCb(err, context) {
        if (err) {
          debug(err);
        }
        if (context) {
          self.closeContextSockets(context);
        }
        return callback(err, context);
      });
  };
};

/**
 * Callback for SocketIoEngine.loadContextSocket
 *
 * @callback SocketIoEngine~contextSocketCallback
 * @param {Error} err
 * @param {io.Socket} socket
 */
