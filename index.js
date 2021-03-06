
var util = require('util')
var EventEmitter = require('events').EventEmitter
var typeforce = require('typeforce')
var debug = require('debug')('sendy-otr')
var connect = require('sendy').connect
var OTR = require('@tradle/otr').OTR
var MSG_ENCODING = 'base64'
var UINT16 = 0xffff
var noop = function () {}

function Client (opts) {
  var self = this

  typeforce({
    client: 'Object',
    key: 'DSA',
    theirFingerprint: 'String',
    instanceTag: '?String',
  }, opts)

  EventEmitter.call(this)

  this._client = opts.client
  connect(this, this._client)

  this._key = opts.key
  this._fingerprint = opts.key.fingerprint()
  this._theirFingerprint = opts.theirFingerprint
  this._instanceTag = opts.instanceTag
  // this.reset()
  this._deliveryCallbacks = []
  this._queue = []
  this._queuedChunks = 0
  this._setupOTR()

  this._client.on('receive', function (msg) {
    // if (self._resetting) return

    if (self._otr) {
      self._debug('received OTR')
      msg = msg.toString()
      self._otr.receiveMsg(msg)
    }
  })
}

util.inherits(Client, EventEmitter)
exports = module.exports = Client

Client.prototype._debug = function () {
  var args = Array.prototype.slice.call(arguments)
  args.unshift(this._fingerprint)
  return debug.apply(null, args)
}

// Client.prototype.reset = function (abortPending) {
//   var self = this
//   if (this._destroyed) return

//   // var cbs = this._deliveryCallbacks && this._deliveryCallbacks.slice()
//   this._debug('resetting')
//   this._deliveryCallbacks = []
//   this._queue = []
//   this._queuedChunks = 0
//   this._resetting = true
//   this._setupOTR()
//   if (this._client.reset) this._client.reset(err)
//   // if (abortPending && cbs) {
//   //   var err = new Error('aborted')
//   //   cbs.forEach(function (fn) {
//   //     fn(err)
//   //   })
//   // }
// }

Client.prototype._setupOTR = function () {
  var self = this

  // if (this._otr) {
  //   var endTimeout = setTimeout(function () {
  //     self._resetting = false
  //   }, 1000)

  //   return this._otr.endOtr(function () {
  //     clearTimeout(endTimeout)
  //     self._resetting = false
  //     self._otr.removeAllListeners()
  //     self._otr = otr = null
  //     self._setupOTR()
  //     // attempt to re-establish session
  //     self._otr.sendQueryMsg()
  //   })
  // } else {
  //   this._resetting = false
  // }

  var otr = this._otr = new OTR({
    priv: this._key,
    instance_tag: this._instanceTag,
    debug: debug.enabled,
  })

  if (this._instanceTag) {
    otr.ALLOW_V2 = false
  } else {
    otr.ALLOW_V3 = false
  }

  otr.REQUIRE_ENCRYPTION = true
  otr.on('io', function (msg, meta) {
    if (self._destroyed) return

    // self._debug('sending', msg)
    self._deliveryCallbacks.push({
      count: ++self._queuedChunks,
      callback: null
    })

    msg = new Buffer(msg) // OTR uses UTF
    self._debug('sending OTR')
    self._client.send(msg, function (err) {
      // more expensive, but simpler
      if (err) return self.destroy()

      // if (err) {
      //   // cancel all queued
      //   self._cancelingPending = true
      //   process.nextTick(function () {
      //     self._cancelingPending = false
      //   })

      //   self._queue.length = 0
      //   var queued = self._deliveryCallbacks.slice()
      //   self._deliveryCallbacks.length = 0
      //   self._queuedChunks = 0
      //   queued.forEach(function (item) {
      //     if (item.callback) item.callback(err)
      //   })

      //   return
      // }

      self._queuedChunks--
      self._deliveryCallbacks.forEach(function (item) {
        item.count--
      })

      var callNow = self._deliveryCallbacks.filter(function (item) {
        return item.count === 0
      })

      self._deliveryCallbacks = self._deliveryCallbacks.filter(function (item) {
        return item.count !== 0
      })

      callNow.forEach(function (item) {
        if (item.callback) item.callback()
      })
    })
  })

  otr.on('ui', function (msg, encrypted) {
    if (self._destroyed) return

    if (!encrypted) {
      self._debug('received unexpected plaintext...self-destructing')
      // return self._resetAndResend()
      return self.destroy()
    }

    self._debug('decrypted OTR message')
    self.emit('receive', new Buffer(msg, MSG_ENCODING))
  })

  // var aked
  otr.on('status', function (status) {
    if (self._destroyed || !otr) return

    self._debug('otr status', status)
    if (status !== OTR.CONST.STATUS_AKE_SUCCESS) {
      // if (aked) {
      //   // whatever we have queued will be discarded as we need to re-AKE
      //   self._debug('resetting queue, need to re-AKE')
      //   self.reset()
      //   aked = false
      // }

      return
    }

    var theirActualFingerprint = otr.their_priv_pk.fingerprint()
    if (self._theirFingerprint === theirActualFingerprint) {
      // aked = true
      return self._debug('AKE successful')
    }

    self.emit('fraud', {
      actualFingerprint: theirActualFingerprint,
      expectedFingerprint: self._theirFingerprint
    })
  })

  otr.on('error', function (err) {
    if (self._destroyed) return

    self.destroy()

    // self._debug('resetting due to OTR error: ' + err)
    // self._resetAndResend()
  })

  otr.sendQueryMsg()

  this._processQueue()
}

Client.prototype.send = function (msg, ondelivered) {
  var self = this
  if (this._destroyed) throw new Error('destroyed')

  if (this._cancelingPending) {
    return process.nextTick(function () {
      self.send(msg, ondelivered)
    })
  }

  this._debug('queueing msg')
  this._queue.push(arguments)
  if (typeof msg === 'string') {
    // assume utf8
    msg = new Buffer(msg)
  }

  if (Buffer.isBuffer(msg)) {
    msg = msg.toString(MSG_ENCODING)
  }

  this._processQueue()
}

// Client.prototype._resetAndResend = function () {
//   var queue = this._queue.slice()
//   this.reset()
//   queue.forEach(function (args) {
//     this.send.apply(this, args)
//   }, this)
// }

Client.prototype._processQueue = function () {
  var self = this
  if (this._destroyed || !this._queue.length) return

  var next = this._queue[0]
  var msg = next[0]
  var ondelivered = next[1] || noop
  this._otr.sendMsg(msg, function () {
    if (self._destroyed) return

    // last 'io' event for this message
    // has just been emitted
    //
    // NOTE: this doesn't work if a session needs to be re-established
    // for some reason during the process of getting this message through
    // so it's better to not rely on this and number messages instead
    self._deliveryCallbacks[self._deliveryCallbacks.length - 1].callback = function (err) {
      self._debug('delivered msg')
      self._queue.shift()
      ondelivered(err)
    }
  })
}

Client.prototype.destroy = function () {
  var self = this
  if (this._destroyed) return

  this._debug('destroying')
  this._destroyed = true
  this._otr.endOtr(function () {
    self._otr.removeAllListeners()
  })

  this._client.destroy()
  this.emit('destroy')
}
