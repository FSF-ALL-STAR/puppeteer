"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HTTPRequest = void 0;
const helper_1 = require("./helper");
class HTTPRequest {
    constructor(client, frame, interceptionId, allowInterception, event, redirectChain) {
        this._failureText = null;
        this._response = null;
        this._fromMemoryCache = false;
        this._interceptionHandled = false;
        this._headers = {};
        this._client = client;
        this._requestId = event.requestId;
        this._isNavigationRequest =
            event.requestId === event.loaderId && event.type === 'Document';
        this._interceptionId = interceptionId;
        this._allowInterception = allowInterception;
        this._url = event.request.url;
        this._resourceType = event.type.toLowerCase();
        this._method = event.request.method;
        this._postData = event.request.postData;
        this._frame = frame;
        this._redirectChain = redirectChain;
        for (const key of Object.keys(event.request.headers))
            this._headers[key.toLowerCase()] = event.request.headers[key];
    }
    url() {
        return this._url;
    }
    resourceType() {
        return this._resourceType;
    }
    method() {
        return this._method;
    }
    postData() {
        return this._postData;
    }
    headers() {
        return this._headers;
    }
    response() {
        return this._response;
    }
    frame() {
        return this._frame;
    }
    isNavigationRequest() {
        return this._isNavigationRequest;
    }
    redirectChain() {
        return this._redirectChain.slice();
    }
    /**
     * @return {?{errorText: string}}
     */
    failure() {
        if (!this._failureText)
            return null;
        return {
            errorText: this._failureText,
        };
    }
    async continue(overrides = {}) {
        // Request interception is not supported for data: urls.
        if (this._url.startsWith('data:'))
            return;
        helper_1.assert(this._allowInterception, 'Request Interception is not enabled!');
        helper_1.assert(!this._interceptionHandled, 'Request is already handled!');
        const { url, method, postData, headers } = overrides;
        this._interceptionHandled = true;
        await this._client
            .send('Fetch.continueRequest', {
            requestId: this._interceptionId,
            url,
            method,
            postData,
            headers: headers ? headersArray(headers) : undefined,
        })
            .catch((error) => {
            // In certain cases, protocol will return error if the request was already canceled
            // or the page was closed. We should tolerate these errors.
            helper_1.debugError(error);
        });
    }
    async respond(response) {
        // Mocking responses for dataURL requests is not currently supported.
        if (this._url.startsWith('data:'))
            return;
        helper_1.assert(this._allowInterception, 'Request Interception is not enabled!');
        helper_1.assert(!this._interceptionHandled, 'Request is already handled!');
        this._interceptionHandled = true;
        const responseBody = response.body && helper_1.helper.isString(response.body)
            ? Buffer.from(response.body)
            : response.body || null;
        const responseHeaders = {};
        if (response.headers) {
            for (const header of Object.keys(response.headers))
                responseHeaders[header.toLowerCase()] = response.headers[header];
        }
        if (response.contentType)
            responseHeaders['content-type'] = response.contentType;
        if (responseBody && !('content-length' in responseHeaders))
            responseHeaders['content-length'] = String(Buffer.byteLength(responseBody));
        await this._client
            .send('Fetch.fulfillRequest', {
            requestId: this._interceptionId,
            responseCode: response.status || 200,
            responsePhrase: STATUS_TEXTS[response.status || 200],
            responseHeaders: headersArray(responseHeaders),
            body: responseBody ? responseBody.toString('base64') : undefined,
        })
            .catch((error) => {
            // In certain cases, protocol will return error if the request was already canceled
            // or the page was closed. We should tolerate these errors.
            helper_1.debugError(error);
        });
    }
    async abort(errorCode = 'failed') {
        // Request interception is not supported for data: urls.
        if (this._url.startsWith('data:'))
            return;
        const errorReason = errorReasons[errorCode];
        helper_1.assert(errorReason, 'Unknown error code: ' + errorCode);
        helper_1.assert(this._allowInterception, 'Request Interception is not enabled!');
        helper_1.assert(!this._interceptionHandled, 'Request is already handled!');
        this._interceptionHandled = true;
        await this._client
            .send('Fetch.failRequest', {
            requestId: this._interceptionId,
            errorReason,
        })
            .catch((error) => {
            // In certain cases, protocol will return error if the request was already canceled
            // or the page was closed. We should tolerate these errors.
            helper_1.debugError(error);
        });
    }
}
exports.HTTPRequest = HTTPRequest;
const errorReasons = {
    aborted: 'Aborted',
    accessdenied: 'AccessDenied',
    addressunreachable: 'AddressUnreachable',
    blockedbyclient: 'BlockedByClient',
    blockedbyresponse: 'BlockedByResponse',
    connectionaborted: 'ConnectionAborted',
    connectionclosed: 'ConnectionClosed',
    connectionfailed: 'ConnectionFailed',
    connectionrefused: 'ConnectionRefused',
    connectionreset: 'ConnectionReset',
    internetdisconnected: 'InternetDisconnected',
    namenotresolved: 'NameNotResolved',
    timedout: 'TimedOut',
    failed: 'Failed',
};
function headersArray(headers) {
    const result = [];
    for (const name in headers) {
        if (!Object.is(headers[name], undefined))
            result.push({ name, value: headers[name] + '' });
    }
    return result;
}
// List taken from https://www.iana.org/assignments/http-status-codes/http-status-codes.xhtml with extra 306 and 418 codes.
const STATUS_TEXTS = {
    '100': 'Continue',
    '101': 'Switching Protocols',
    '102': 'Processing',
    '103': 'Early Hints',
    '200': 'OK',
    '201': 'Created',
    '202': 'Accepted',
    '203': 'Non-Authoritative Information',
    '204': 'No Content',
    '205': 'Reset Content',
    '206': 'Partial Content',
    '207': 'Multi-Status',
    '208': 'Already Reported',
    '226': 'IM Used',
    '300': 'Multiple Choices',
    '301': 'Moved Permanently',
    '302': 'Found',
    '303': 'See Other',
    '304': 'Not Modified',
    '305': 'Use Proxy',
    '306': 'Switch Proxy',
    '307': 'Temporary Redirect',
    '308': 'Permanent Redirect',
    '400': 'Bad Request',
    '401': 'Unauthorized',
    '402': 'Payment Required',
    '403': 'Forbidden',
    '404': 'Not Found',
    '405': 'Method Not Allowed',
    '406': 'Not Acceptable',
    '407': 'Proxy Authentication Required',
    '408': 'Request Timeout',
    '409': 'Conflict',
    '410': 'Gone',
    '411': 'Length Required',
    '412': 'Precondition Failed',
    '413': 'Payload Too Large',
    '414': 'URI Too Long',
    '415': 'Unsupported Media Type',
    '416': 'Range Not Satisfiable',
    '417': 'Expectation Failed',
    '418': "I'm a teapot",
    '421': 'Misdirected Request',
    '422': 'Unprocessable Entity',
    '423': 'Locked',
    '424': 'Failed Dependency',
    '425': 'Too Early',
    '426': 'Upgrade Required',
    '428': 'Precondition Required',
    '429': 'Too Many Requests',
    '431': 'Request Header Fields Too Large',
    '451': 'Unavailable For Legal Reasons',
    '500': 'Internal Server Error',
    '501': 'Not Implemented',
    '502': 'Bad Gateway',
    '503': 'Service Unavailable',
    '504': 'Gateway Timeout',
    '505': 'HTTP Version Not Supported',
    '506': 'Variant Also Negotiates',
    '507': 'Insufficient Storage',
    '508': 'Loop Detected',
    '510': 'Not Extended',
    '511': 'Network Authentication Required',
};
