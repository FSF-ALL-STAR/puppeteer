"use strict";
/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Touchscreen = exports.Mouse = exports.Keyboard = void 0;
const helper_1 = require("./helper");
const USKeyboardLayout_1 = require("./USKeyboardLayout");
class Keyboard {
    constructor(client) {
        this._modifiers = 0;
        this._pressedKeys = new Set();
        this._client = client;
    }
    async down(key, options = { text: undefined }) {
        const description = this._keyDescriptionForString(key);
        const autoRepeat = this._pressedKeys.has(description.code);
        this._pressedKeys.add(description.code);
        this._modifiers |= this._modifierBit(description.key);
        const text = options.text === undefined ? description.text : options.text;
        await this._client.send('Input.dispatchKeyEvent', {
            type: text ? 'keyDown' : 'rawKeyDown',
            modifiers: this._modifiers,
            windowsVirtualKeyCode: description.keyCode,
            code: description.code,
            key: description.key,
            text: text,
            unmodifiedText: text,
            autoRepeat,
            location: description.location,
            isKeypad: description.location === 3,
        });
    }
    _modifierBit(key) {
        if (key === 'Alt')
            return 1;
        if (key === 'Control')
            return 2;
        if (key === 'Meta')
            return 4;
        if (key === 'Shift')
            return 8;
        return 0;
    }
    _keyDescriptionForString(keyString) {
        const shift = this._modifiers & 8;
        const description = {
            key: '',
            keyCode: 0,
            code: '',
            text: '',
            location: 0,
        };
        const definition = USKeyboardLayout_1.keyDefinitions[keyString];
        helper_1.assert(definition, `Unknown key: "${keyString}"`);
        if (definition.key)
            description.key = definition.key;
        if (shift && definition.shiftKey)
            description.key = definition.shiftKey;
        if (definition.keyCode)
            description.keyCode = definition.keyCode;
        if (shift && definition.shiftKeyCode)
            description.keyCode = definition.shiftKeyCode;
        if (definition.code)
            description.code = definition.code;
        if (definition.location)
            description.location = definition.location;
        if (description.key.length === 1)
            description.text = description.key;
        if (definition.text)
            description.text = definition.text;
        if (shift && definition.shiftText)
            description.text = definition.shiftText;
        // if any modifiers besides shift are pressed, no text should be sent
        if (this._modifiers & ~8)
            description.text = '';
        return description;
    }
    async up(key) {
        const description = this._keyDescriptionForString(key);
        this._modifiers &= ~this._modifierBit(description.key);
        this._pressedKeys.delete(description.code);
        await this._client.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            modifiers: this._modifiers,
            key: description.key,
            windowsVirtualKeyCode: description.keyCode,
            code: description.code,
            location: description.location,
        });
    }
    async sendCharacter(char) {
        await this._client.send('Input.insertText', { text: char });
    }
    charIsKey(char) {
        return !!USKeyboardLayout_1.keyDefinitions[char];
    }
    async type(text, options) {
        const delay = (options && options.delay) || null;
        for (const char of text) {
            if (this.charIsKey(char)) {
                await this.press(char, { delay });
            }
            else {
                if (delay)
                    await new Promise((f) => setTimeout(f, delay));
                await this.sendCharacter(char);
            }
        }
    }
    async press(key, options = {}) {
        const { delay = null } = options;
        await this.down(key, options);
        if (delay)
            await new Promise((f) => setTimeout(f, options.delay));
        await this.up(key);
    }
}
exports.Keyboard = Keyboard;
class Mouse {
    /**
     * @param {CDPSession} client
     * @param {!Keyboard} keyboard
     */
    constructor(client, keyboard) {
        this._x = 0;
        this._y = 0;
        this._button = 'none';
        this._client = client;
        this._keyboard = keyboard;
    }
    async move(x, y, options = {}) {
        const { steps = 1 } = options;
        const fromX = this._x, fromY = this._y;
        this._x = x;
        this._y = y;
        for (let i = 1; i <= steps; i++) {
            await this._client.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                button: this._button,
                x: fromX + (this._x - fromX) * (i / steps),
                y: fromY + (this._y - fromY) * (i / steps),
                modifiers: this._keyboard._modifiers,
            });
        }
    }
    async click(x, y, options = {}) {
        const { delay = null } = options;
        if (delay !== null) {
            await Promise.all([this.move(x, y), this.down(options)]);
            await new Promise((f) => setTimeout(f, delay));
            await this.up(options);
        }
        else {
            await Promise.all([
                this.move(x, y),
                this.down(options),
                this.up(options),
            ]);
        }
    }
    async down(options = {}) {
        const { button = 'left', clickCount = 1 } = options;
        this._button = button;
        await this._client.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            button,
            x: this._x,
            y: this._y,
            modifiers: this._keyboard._modifiers,
            clickCount,
        });
    }
    /**
     * @param {!{button?: "left"|"right"|"middle", clickCount?: number}=} options
     */
    async up(options = {}) {
        const { button = 'left', clickCount = 1 } = options;
        this._button = 'none';
        await this._client.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            button,
            x: this._x,
            y: this._y,
            modifiers: this._keyboard._modifiers,
            clickCount,
        });
    }
}
exports.Mouse = Mouse;
class Touchscreen {
    constructor(client, keyboard) {
        this._client = client;
        this._keyboard = keyboard;
    }
    /**
     * @param {number} x
     * @param {number} y
     */
    async tap(x, y) {
        // Touches appear to be lost during the first frame after navigation.
        // This waits a frame before sending the tap.
        // @see https://crbug.com/613219
        await this._client.send('Runtime.evaluate', {
            expression: 'new Promise(x => requestAnimationFrame(() => requestAnimationFrame(x)))',
            awaitPromise: true,
        });
        const touchPoints = [{ x: Math.round(x), y: Math.round(y) }];
        await this._client.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints,
            modifiers: this._keyboard._modifiers,
        });
        await this._client.send('Input.dispatchTouchEvent', {
            type: 'touchEnd',
            touchPoints: [],
            modifiers: this._keyboard._modifiers,
        });
    }
}
exports.Touchscreen = Touchscreen;