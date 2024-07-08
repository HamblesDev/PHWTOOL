/********************
 * MODIFIED BY KENNETH *
 ********************/

// source: https://github.com/zizifn/edgetunnel

import { connect } from 'cloudflare:sockets';

/* EDIT YOUR UUID */
let userID = `0477e400-121c-4423-ab32-0e780e495b34`
/* IF YOU WANT TO GENERATE UUID,
ENTER YOUR PAGES.DEV SITE THEN ADD /uuid
Example: https://phwtool.pages.dev/uuid */

let proxyIP = '';
if (!isValidUUID(userID)) {
  throw new Error('uuid is not valid');
}

export default {
  async fetch(request, env, ctx) {
    try {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        const url = new URL(request.url);
        switch (url.pathname) {
          case '/': {
            return new Response(html(), {
              status: 200,
              headers: {
                "Content-Type": "text/html;charset=utf-8",
              }
            });
          }
          case '/status': {
            return new Response(JSON.stringify(request.cf), { status: 200 });
          }
          case `/config`: {
            const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'));
            return new Response(`${vlessConfig}`, {
              status: 200,
              headers: {
                "Content-Type": "text/plain;charset=utf-8",
              }
            });
          }
          case '/uuid': {
            function gg() {
              var d = new Date().getTime();
              var d2 = ((typeof performance !== 'undefined') && performance.now && (performance.now() * 1000)) || 0;
              return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                var r = Math.random() * 16;
                if (d > 0) {
                  r = (d + r) % 16 | 0;
                  d = Math.floor(d / 16);
                } else {
                  r = (d2 + r) % 16 | 0;
                  d2 = Math.floor(d2 / 16);
                }
                return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
              });
            }
            const js = JSON.stringify({ uuid: gg() }, null, 4);
            return new Response(/*js*/ gg(), {
              status: 200,
              headers: {
                "Content-Type": "text/plain;charset=utf-8",
              }
            });
          }
          default:
            return new Response('Not found', { status: 404 });
        }
      } else {
        return await vlessOverWSHandler(request);
      }
    } catch (err) {
      /** @type {Error} */
      let e = err;
      return new Response(e.toString());
    }
  }
};





/**
 * 
 * @param {import("@cloudflare/workers-types").Request} request
 */
async function vlessOverWSHandler(request) {

  /** @type {import("@cloudflare/workers-types").WebSocket[]} */
  // @ts-ignore
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);

  webSocket.accept();

  let address = '';
  let portWithRandomLog = '';
  const log = ( /** @type {string} */ info, /** @type {string | undefined} */ event) => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
  };
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

  /** @type {{ value: import("@cloudflare/workers-types").Socket | null}}*/
  let remoteSocketWapper = {
    value: null,
  };
  let udpStreamWrite = null;
  let isDns = false;

  // ws --> remote
  readableWebSocketStream.pipeTo(new WritableStream({
    async write(chunk, controller) {
      if (isDns && udpStreamWrite) {
        return udpStreamWrite(chunk);
      }
      if (remoteSocketWapper.value) {
        const writer = remoteSocketWapper.value.writable.getWriter()
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }

      const {
        hasError,
        message,
        portRemote = 443,
        addressRemote = '',
        rawDataIndex,
        vlessVersion = new Uint8Array([0, 0]),
        isUDP,
      } = processVlessHeader(chunk, userID);
      address = addressRemote;
      portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '
				} `;
      if (hasError) {
        // controller.error(message);
        throw new Error(message); // cf seems has bug, controller.error will not end stream
        // webSocket.close(1000, message);
        return;
      }
      // if UDP but port not DNS port, close it
      if (isUDP) {
        if (portRemote === 53) {
          isDns = true;
        } else {
          // controller.error('UDP proxy only enable for DNS which is port 53');
          throw new Error('UDP proxy only enable for DNS which is port 53'); // cf seems has bug, controller.error will not end stream
          return;
        }
      }
      // ["version", "附加信息长度 N"]
      const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);

      // TODO: support udp here when cf runtime has udp support
      if (isDns) {
        const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader, log);
        udpStreamWrite = write;
        udpStreamWrite(rawClientData);
        return;
      }
      handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log);
    },
    close() {
      log(`readableWebSocketStream is close`);
    },
    abort(reason) {
      log(`readableWebSocketStream is abort`, JSON.stringify(reason));
    },
  })).catch((err) => {
    log('readableWebSocketStream pipeTo error', err);
  });

  return new Response(null, {
    status: 101,
    message: "By Neth",
    webSocket: client,
  });
}

/**
 * Handles outbound TCP connections.
 *
 * @param {any} remoteSocket 
 * @param {string} addressRemote The remote address to connect to.
 * @param {number} portRemote The remote port to connect to.
 * @param {Uint8Array} rawClientData The raw client data to write.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket The WebSocket to pass the remote socket to.
 * @param {Uint8Array} vlessResponseHeader The VLESS response header.
 * @param {function} log The logging function.
 * @returns {Promise<void>} The remote socket.
 */
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log, ) {
  async function connectAndWrite(address, port) {
    /** @type {import("@cloudflare/workers-types").Socket} */
    const tcpSocket = connect({
      hostname: address,
      port: port,
    });
    remoteSocket.value = tcpSocket;
    log(`connected to ${address}:${port}`);
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData); // first write, nomal is tls client hello
    writer.releaseLock();
    return tcpSocket;
  }

  // if the cf connect tcp socket have no incoming data, we retry to redirect ip
  async function retry() {
    const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote)
    // no matter retry success or not, close websocket
    tcpSocket.closed.catch(error => {
      console.log('retry tcpSocket closed error', error);
    }).finally(() => {
      safeCloseWebSocket(webSocket);
    })
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
  }

  const tcpSocket = await connectAndWrite(addressRemote, portRemote);

  // when remoteSocket is ready, pass to websocket
  // remote--> ws
  remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

/**
 * 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocketServer
 * @param {string} earlyDataHeader for ws 0rtt
 * @param {(info: string)=> void} log for ws 0rtt
 */
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
  let readableStreamCancel = false;
  const stream = new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => {
        if (readableStreamCancel) {
          return;
        }
        const message = event.data;
        controller.enqueue(message);
      });

      // The event means that the client closed the client -> server stream.
      // However, the server -> client stream is still open until you call close() on the server side.
      // The WebSocket protocol says that a separate close message must be sent in each direction to fully close the socket.
      webSocketServer.addEventListener('close', () => {
        // client send close, need close server
        // if stream is cancel, skip controller.close
        safeCloseWebSocket(webSocketServer);
        if (readableStreamCancel) {
          return;
        }
        controller.close();
      });
      webSocketServer.addEventListener('error', (err) => {
        log('webSocketServer has error');
        controller.error(err);
      });
      // for ws 0rtt
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },

    pull(controller) {
      // if ws can stop read if stream is full, we can implement backpressure
      // https://streams.spec.whatwg.org/#example-rs-push-backpressure
    },
    cancel(reason) {
      // 1. pipe WritableStream has error, this cancel will called, so ws handle server close into here
      // 2. if readableStream is cancel, all controller.close/enqueue need skip,
      // 3. but from testing controller.error still work even if readableStream is cancel
      if (readableStreamCancel) {
        return;
      }
      log(`ReadableStream was canceled, due to ${reason}`)
      readableStreamCancel = true;
      safeCloseWebSocket(webSocketServer);
    }
  });

  return stream;

}

// https://xtls.github.io/development/protocols/vless.html
// https://github.com/zizifn/excalidraw-backup/blob/main/v2ray-protocol.excalidraw

/**
 * 
 * @param { ArrayBuffer} vlessBuffer 
 * @param {string} userID 
 * @returns 
 */
function processVlessHeader(
  vlessBuffer,
  userID
) {
  if (vlessBuffer.byteLength < 24) {
    return {
      hasError: true,
      message: 'invalid data',
    };
  }
  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  let isValidUser = false;
  let isUDP = false;
  if (stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID) {
    isValidUser = true;
  }
  if (!isValidUser) {
    return {
      hasError: true,
      message: 'invalid user',
    };
  }

  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
  //skip opt for now

  const command = new Uint8Array(
    vlessBuffer.slice(18 + optLength, 18 + optLength + 1)
  )[0];

  // 0x01 TCP
  // 0x02 UDP
  // 0x03 MUX
  if (command === 1) {} else if (command === 2) {
    isUDP = true;
  } else {
    return {
      hasError: true,
      message: `command ${command} is not support, command 01-tcp,02-udp,03-mux`,
    };
  }
  const portIndex = 18 + optLength + 1;
  const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
  // port is big-Endian in raw data etc 80 == 0x005d
  const portRemote = new DataView(portBuffer).getUint16(0);

  let addressIndex = portIndex + 2;
  const addressBuffer = new Uint8Array(
    vlessBuffer.slice(addressIndex, addressIndex + 1)
  );

  // 1--> ipv4  addressLength =4
  // 2--> domain name addressLength=addressBuffer[1]
  // 3--> ipv6  addressLength =16
  const addressType = addressBuffer[0];
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = '';
  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = new Uint8Array(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      ).join('.');
      break;
    case 2:
      addressLength = new Uint8Array(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + 1)
      )[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      break;
    case 3:
      addressLength = 16;
      const dataView = new DataView(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      // 2001:0db8:85a3:0000:0000:8a2e:0370:7334
      const ipv6 = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6.join(':');
      // seems no need add [] for ipv6
      break;
    default:
      return {
        hasError: true,
          message: `invild  addressType is ${addressType}`,
      };
  }
  if (!addressValue) {
    return {
      hasError: true,
      message: `addressValue is empty, addressType is ${addressType}`,
    };
  }

  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP,
  };
}


/**
 * 
 * @param {import("@cloudflare/workers-types").Socket} remoteSocket 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket 
 * @param {ArrayBuffer} vlessResponseHeader 
 * @param {(() => Promise<void>) | null} retry
 * @param {*} log 
 */
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
  // remote--> ws
  let remoteChunkCount = 0;
  let chunks = [];
  /** @type {ArrayBuffer | null} */
  let vlessHeader = vlessResponseHeader;
  let hasIncomingData = false; // check if remoteSocket has incoming data
  await remoteSocket.readable
    .pipeTo(
      new WritableStream({
        start() {},
        /**
         * 
         * @param {Uint8Array} chunk 
         * @param {*} controller 
         */
        async write(chunk, controller) {
          hasIncomingData = true;
          // remoteChunkCount++;
          if (webSocket.readyState !== WS_READY_STATE_OPEN) {
            controller.error(
              'webSocket.readyState is not open, maybe close'
            );
          }
          if (vlessHeader) {
            webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
            vlessHeader = null;
          } else {
            // seems no need rate limit this, CF seems fix this??..
            // if (remoteChunkCount > 20000) {
            // 	// cf one package is 4096 byte(4kb),  4096 * 20000 = 80M
            // 	await delay(1);
            // }
            webSocket.send(chunk);
          }
        },
        close() {
          log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
          // safeCloseWebSocket(webSocket); // no need server close websocket frist for some case will casue HTTP ERR_CONTENT_LENGTH_MISMATCH issue, client will send close event anyway.
        },
        abort(reason) {
          console.error(`remoteConnection!.readable abort`, reason);
        },
      })
    )
    .catch((error) => {
      console.error(
        `remoteSocketToWS has exception `,
        error.stack || error
      );
      safeCloseWebSocket(webSocket);
    });

  // seems is cf connect socket have error,
  // 1. Socket.closed will have error
  // 2. Socket.readable will be close without any data coming
  if (hasIncomingData === false && retry) {
    log(`retry`)
    retry();
  }
}

/**
 * 
 * @param {string} base64Str 
 * @returns 
 */
function base64ToArrayBuffer(base64Str) {
  if (!base64Str) {
    return { error: null };
  }
  try {
    // go use modified Base64 for URL rfc4648 which js atob not support
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
}

/**
 * This is not real UUID validation
 * @param {string} uuid 
 */
function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
/**
 * Normally, WebSocket will not has exceptions when close.
 * @param {import("@cloudflare/workers-types").WebSocket} socket
 */
function safeCloseWebSocket(socket) {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close();
    }
  } catch (error) {
    console.error('safeCloseWebSocket error', error);
  }
}

const byteToHex = [];
for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}

function unsafeStringify(arr, offset = 0) {
  return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}

function stringify(arr, offset = 0) {
  const uuid = unsafeStringify(arr, offset);
  if (!isValidUUID(uuid)) {
    throw TypeError("Stringified UUID is invalid");
  }
  return uuid;
}


/**
 * 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket 
 * @param {ArrayBuffer} vlessResponseHeader 
 * @param {(string)=> void} log 
 */
async function handleUDPOutBound(webSocket, vlessResponseHeader, log) {

  let isVlessHeaderSent = false;
  const transformStream = new TransformStream({
    start(controller) {

    },
    transform(chunk, controller) {
      // udp message 2 byte is the the length of udp data
      // TODO: this should have bug, beacsue maybe udp chunk can be in two websocket message
      for (let index = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(
          chunk.slice(index + 2, index + 2 + udpPakcetLength)
        );
        index = index + 2 + udpPakcetLength;
        controller.enqueue(udpData);
      }
    },
    flush(controller) {}
  });

  // only handle dns udp for now
  transformStream.readable.pipeTo(new WritableStream({
    async write(chunk) {
      const resp = await fetch('https://1.1.1.1/dns-query',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/dns-message',
        },
        body: chunk,
      })
      const dnsQueryResult = await resp.arrayBuffer();
      const udpSize = dnsQueryResult.byteLength;
      // console.log([...new Uint8Array(dnsQueryResult)].map((x) => x.toString(16)));
      const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
      if (webSocket.readyState === WS_READY_STATE_OPEN) {
        log(`doh success and dns message length is ${udpSize}`);
        if (isVlessHeaderSent) {
          webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
        } else {
          webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
          isVlessHeaderSent = true;
        }
      }
    }
  })).catch((error) => {
    log('dns udp has error' + error)
  });

  const writer = transformStream.writable.getWriter();

  return {
    /**
     * 
     * @param {Uint8Array} chunk 
     */
    write(chunk) {
      writer.write(chunk);
    }
  };
}

/**
 * 
 * @param {string} userID 
 * @param {string | null} hostName
 * @returns {string}
 */
function getVLESSConfig(userID, hostName) {
  const vlessMain = `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#neth`
  return `${vlessMain}
  
- V2Ray Config -
name: ${hostName}
server: ${hostName}
port: 443
uuid: ${userID}
network: ws
tls: true
udp: false
sni: ${hostName}
client-fingerprint: chrome
ws-opts:
    path: "/?ed=2048"
    headers:
      host: ${hostName}
`;
}

function html(){
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PHWTOOL AI</title>
    <link rel="icon" type="image/x-icon" href="https://r2.easyimg.io/py4d95dyk/25694.png">
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/animate.css/4.1.1/animate.min.css">
    <style>
        body {
            font-family: 'Poppins', sans-serif;
            margin: 0;
            padding: 0;
            background-color: #FEECEB;
            color: #1e1e1e;
            overflow-x: hidden;
            transition: background-color 0.3s, color 0.3s;
            scroll-behavior: smooth;
        }

        .preloader {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: #313638;
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 1000;
            animation: fadeIn 0.5s ease;
        }

        .preloader .spinner {
            width: 50px;
            height: 50px;
            border: 6px solid #342E37;
            border-top: 6px solid #4CAF50;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .container {
            display: none;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            padding: 20px;
            box-sizing: border-box;
        }

        .toggle-container {
            position: absolute;
            top: 20px;
            right: 20px;
        }

        main {
            max-width: 800px;
            text-align: center;
            padding: 20px;
            background-color: #FAF5FF;
            border-radius: 20px;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
            transition: background-color 0.3s, box-shadow 0.3s;
            margin: 40px 0;
        }

        .logo-container {
            display: flex;
            justify-content: center;
            align-items: center;
            width: 120px;
            height: 120px;
            border-radius: 50%;
            background: linear-gradient(135deg, #FAF5FF, #313638);
            margin-bottom: 20px;
            animation: rotateLogo 5s linear infinite;
            position: relative;
        }

        @keyframes rotateLogo {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .logo {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background-color: #f5f5f5;
            display: flex;
            justify-content: center;
            align-items: center;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
        }

        .logo img {
            width: 70px;
            height: 70px;
            border-radius: 50%;
        }

        h1 {
            color: #1e1e1e;
            margin-bottom: 20px;
            font-size: 32px;
            transition: color 0.3s;
            animation: fadeIn 1s ease-in-out;
        }

        h2 {
            color: #1e1e1e;
            margin-bottom: 20px;
            font-size: 28px;
            transition: color 0.3s;
            animation: fadeIn 1s ease-in-out;
        }

        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        .tabs {
            display: flex;
            justify-content: center;
            margin-bottom: 20px;
        }

        .tabs button {
            background-color: #4CAF50;
            color: #fff;
            border: none;
            padding: 10px 20px;
            cursor: pointer;
            border-radius: 20px;
            font-size: 14px;
            margin: 0 5px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            transition: background-color 0.3s, transform 0.3s, box-shadow 0.3s;
        }

        .tabs button:hover {
            background-color: #45a049;
            transform: scale(1.05);
            box-shadow: 0 6px 8px rgba(0, 0, 0, 0.15);
        }

        .tabs button.active {
            background-color: #66BB6A;
        }

        .links {
            display: none;
            flex-direction: column;
            gap: 15px;
            justify-content: center;
            margin-top: 20px;
            opacity: 0;
            transition: opacity 0.5s ease, transform 0.5s ease;
            transform: translateY(20px);
        }

        .links.active {
            display: flex;
            opacity: 1;
            transform: translateY(0);
        }

        .links a {
            display: block;
            padding: 10px 20px;
            text-decoration: none;
            color: #1e1e1e;
            background: linear-gradient(135deg, #4CAF50, #2E7D32);
            border-radius: 20px;
            transition: background 0.3s, transform 0.2s, box-shadow 0.3s;
            text-align: center;
            font-size: 14px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            animation: slideIn 1s ease-in-out;
        }

        @keyframes slideIn {
            from { transform: translateY(20px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }

        .links a:hover {
            background: linear-gradient(135deg, #66BB6A, #43A047);
            transform: scale(1.05);
            box-shadow: 0 6px 8px rgba(0, 0, 0, 0.15);
        }

        footer {
            background-color: #ffffff;
            color: #1e1e1e;
            text-align: center;
            padding: 20px 0;
            width: 100%;
            box-shadow: 0 -2px 4px rgba(0, 0, 0, 0.1);
            transition: background-color 0.3s, box-shadow 0.3s;
        }

        footer p {
            margin: 0;
            font-size: 14px;
        }

        .modal {
            display: none;
            position: fixed;
            z-index: 1001;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            overflow: auto;
            background-color: rgba(0, 0, 0, 0.5);
            padding-top: 60px;
            opacity: 0;
            transition: opacity 0.5s ease;
        }

        .modal.show {
            display: block;
            opacity: 1;
        }

        .modal-content {
            background-color: #ffffff;
            margin: 5% auto;
            padding: 20px;
            border: 1px solid #888;
            width: 80%;
            max-width: 500px;
            border-radius: 20px;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
            position: relative;
            text-align: left;
            color: #1e1e1e;
            transform: translateY(-50px);
            transition: transform 0.5s ease;
        }

        .modal.show .modal-content {
            transform: translateY(0);
        }

        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #888;
            padding-bottom: 10px;
        }

        .modal-body {
            padding-top: 10px;
        }

        .close {
            color: #aaa;
            float: right;
            font-size: 28px;
            font-weight: bold;
            cursor: pointer;
        }

        .close:hover,
        .close:focus {
            color: #000;
            text-decoration: none;
            cursor: pointer;
        }

        @media (max-width: 768px) {
            main {
                padding: 15px;
            }

            .tabs button {
                padding: 8px 16px;
                font-size: 12px;
            }

            .links a {
                padding: 10px 15px;
                font-size: 12px;
            }

            .modal-content {
                width: 90%;
            }
        }

        @media (max-width: 480px) {
            main {
                padding: 10px;
            }

            .tabs button {
                padding: 8px 12px;
                font-size: 12px;
            }

            .links a {
                padding: 10px 15px;
                font-size: 12px;
            }

            h1 {
                font-size: 24px;
            }

            h2 {
                font-size: 20px;
            }

            footer p {
                font-size: 12px;
            }
        }

        @media (min-width: 1024px) {
            .links a {
                font-size: 16px;
            }

            .tabs button {
                font-size: 16px;
                padding: 12px 24px;
            }

            h1 {
                font-size: 28px;
            }

            h2 {
                font-size: 24px;
            }
        }
    </style>
</head>
<body>

<div class="preloader" id="preloader" role="alert" aria-live="assertive">
    <div class="spinner" role="status" aria-label="Loading.."></div>
</div>

<div class="container">
    <main role="main">
        <div class="logo-container">
            <div class="logo">
                <img src="https://i.ibb.co/QQ3PNNN/6056254-200.png" alt="PHWTOOL Logo">
            </div>
        </div>
        <h1 class="animate__animated animate__fadeInDown">Welcome to PHWTOOL</h1>
        <h2 class="animate__animated animate__fadeInUp">Developed by Kenneth Perez</h2>

        <div class="tabs" rolea="tablist">
            <button role="tab" aria-selected="true" aria-controls="others" id="others-tab" class="active">TOOLS</button>
            <button role="tab" aria-selected="false" aria-controls="ais" id="ais-tab">AI [CONVERSATIONAL]</button>
        </div>

        <div id="others" class="links active" role="tabpanel" aria-labelledby="others-tab">
            <a href="https://phwtool.vercel.app/shoti.html" aria-label="Shoti Videos" title="Random Videos Shoti">Shoti Videos</a>
            <a href="https://token-getter-uqi5.onrender.com/" aria-label="Facebook Token Getter" title="Get Facebook Token">Facebook Token Getter</a>
            <a href="https://polongdev-autoreact.onrender.com" aria-label="Facebook React Boost" title="Spam Reaction on Facebook">Facebook React Boost</a>
            <a href="https://phwtool.vercel.app/instagramdownloader.html" aria-label="Instagram Video Downloader" title="Download videos from Instagram">Instagram Video Downloader</a>
            <a href="https://phwtool.vercel.app/spotifydownloader.html" aria-label="Spotify Music Downloader" title="Download music from Spotify">Spotify Music Downloader</a>
            <a href="https://phwtool.vercel.app/tiktokdownloader.html" aria-label="TikTok Video Downloader" title="Download videos from TikTok">TikTok Video Downloader</a>
            <a href="https://phwtool.vercel.app/fbdownloader.html" aria-label="Facebook Video Downloader" title="Download videos from Facebook">Facebook Video Downloader</a>
            <a href="https://phwtool.vercel.app/fbreelsdownloader.html" aria-label="Facebook Reels Downloader" title="Download reels from Facebook">Facebook Reels Downloader</a>
            <a href="https://phwtool.vercel.app/imagetolink.html" aria-label="Image to Link Uploader" title="Upload images and get shareable links">Image to Link Uploader</a>
            <a href="https://phwtool.vercel.app/imagesearch.html" aria-label="Image Search" title="Search for images online">Image Search</a>
            <a href="https://phwtool.vercel.app/chordfinder.html" aria-label="Music Chord Finder" title="Find music Chords online">Music Chord Finder</a>
        </div>

        <div id="ais" class="links" role="tabpanel" aria-labelledby="ais-tab">
            <a href="https://phwtool.vercel.app/luffy.html" aria-label="Monkey D. Luffy (C.AI)" title="Access C.AI">Monkey D. Luffy (C.AI)</a>
            <a href="https://phwtool.vercel.app/codestral.html" aria-label="Satoru Gojo (C.AI)" title="Access C.AI">Satoru Gojo (C.AI)</a>
            <a href="https://phwtool.vercel.app/deku.html" aria-label="Deku AI" title="Access Deku AI">Deku AI</a>
            <a href="https://phwtool.vercel.app/blackbox.html" aria-label="Blackbox AI" title="Access Blackbox AI">Blackbox AI</a>
            <a href="https://phwtool.vercel.app/claude.html" aria-label="Zephyr-7B" title="Access Zephyr-7B">Zephyr-7B</a>
            <a href="https://phwtool.vercel.app/aigirlfriend.html" aria-label="Microsoft WizardLM" title="Interact with Microsoft WizardLM">Microsoft WizardLM</a>
            <a href="https://phwtool.vercel.app/liner.html" aria-label="Linerva Pro" title="Access Linerva Pro">Linerva Pro</a>
            <a href="https://phwtool.vercel.app/llama.html" aria-label="LLaMA 3-8B" title="Access LLaMA 3-8B">LLaMA 3-8B</a>
            <a href="https://phwtool.vercel.app/qwen.html" aria-label="Qwen 1.5-14B" title="Access Qwen 1.5-14B">Qwen 1.5-14B</a>
            <a href="https://phwtool.vercel.app/gemma.html" aria-label="Gemma-7B" title="Access Gemma-7B">Gemma-7B</a>
            <a href="https://phwtool.vercel.app/palm.html" aria-label="Microsoft Phi-2" title="Access Microsoft Phi-2">Microsoft Phi-2</a>
            <a href="https://phwtool.vercel.app/hermes.html" aria-label="Open Hermes 2.5" title="Access Open Hermes 2.5">Open Hermes 2.5</a>
            <a href="https://phwtool.vercel.app/phwtoolgpt.html" aria-label="ChatGPT 4" title="Access ChatGPT 4">ChatGPT 4</a>
            <a href="https://phwtool.vercel.app/phwtool.html" aria-label="OpenChat 3.5" title="Access OpenChat 3.5">OpenChat 3.5</a>
        </div>
    </main>

    <footer role="contentinfo">
        <p>&copy; 2024 PHWTOOL AI. All Rights Reserved</p>
    </footer>

    <div id="contactModal" class="modal" role="dialog" aria-modal="true">
        <div class="modal-content">
            <div class="modal-header">
                <span class="close" aria-label="Close">&times;</span>
                <h2>Contact Us</h2>
            </div>
            <div class="modal-body">
                <form id="contactForm" aria-label="Contact Form">
                    <label for="name">Name:</label>
                    <input type="text" id="name" name="name" required aria-required="true" aria-label="Name"><br><br>
                    <label for="email">Email:</label>
                    <input type="email" id="email" name="email" required aria-required="true" aria-label="Email"><br><br>
                    <label for="message">Message:</label><br>
                    <textarea id="message" name="message" required aria-required="true" aria-label="Message"></textarea><br><br>
                    <button type="submit" aria-label="Submit">Submit</button>
                </form>
            </div>
        </div>
    </div>
</div>

<script>
    window.addEventListener('load', () => {
        const preloader = document.getElementById('preloader');
        const container = document.querySelector('.container');
        preloader.style.display = 'none';
        container.style.display = 'flex';
    });

    const tabs = document.querySelectorAll('.tabs button');
    const tabPanels = document.querySelectorAll('.links');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            tabPanels.forEach(panel => {
                panel.classList.remove('active');
                if (panel.id === tab.getAttribute('aria-controls')) {
                    panel.classList.add('active');
                }
            });
        });
    });

    const modal = document.getElementById('contactModal');
    const closeBtn = document.getElementsByClassName('close')[0];

    closeBtn.addEventListener('click', () => {
        modal.classList.remove('show');
    });

    window.addEventListener('click', (event) => {
        if (event.target === modal) {
            modal.classList.remove('show');
        }
    });

    modal.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            modal.classList.remove('show');
        }
    });

    const contactForm = document.getElementById('contactForm');
    contactForm.addEventListener('submit', (event) => {
        event.preventDefault();
        alert('Form submitted!');
        modal.classList.remove('show');
        contactForm.reset();
    });
</script>
</body>
</html>
`;
}
