/**
 * USB Connection for WebUSB
 * Supports both old (reconfigurable) and new (GBLink unified) firmware.
 * Based on gblink-multiboot-web/usb_connection.js
 */

function fwVersionAtLeast(device, minMajor, minMinor, minPatch) {
    if (!device) return false;
    const major = device.deviceVersionMajor || 0;
    const minor = device.deviceVersionMinor || 0;
    const patch = device.deviceVersionSubminor || 0;
    if (major !== minMajor) return major > minMajor;
    if (minor !== minMinor) return minor > minMinor;
    return patch >= minPatch;
}

const MAGIC_PREFIX = new Uint8Array([
    0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE,
    0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE,
    0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF,
    0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF
]);

function buildVswitchPacket(suffix) {
    const packet = new Uint8Array(36);
    packet.set(MAGIC_PREFIX);
    packet.set(new TextEncoder().encode(suffix), 32);
    return packet;
}

const VSWITCH_3V3_PACKET = buildVswitchPacket('V3V3');
const VSWITCH_5V_PACKET = buildVswitchPacket('V5V0');

const CMD = {
    SET_MODE: 0x00,
    CANCEL: 0x01,
    GET_FIRMWARE_INFO: 0x0F,
    SET_TIMING_CONFIG: 0x30,
    SET_VOLTAGE_3V3: 0x40,
    SET_VOLTAGE_5V: 0x41,
    SET_LED_COLOR: 0x42,
};

const MODE = {
    GBA_TRADE_EMU: 0x00,
    GBA_LINK: 0x01,
    GB_LINK: 0x02,
};

class UsbConnection {
    constructor() {
        this.device = null;
        this.interfaceNumber = 0;
        this.endpointIn = 0;
        this.endpointOut = 0;
        this.cmdEndpointIn = 0;
        this.cmdEndpointOut = 0;
        this.isConnected = false;
        this.isNewFirmware = false;
    }

    async connect() {
        const filters = [
            { vendorId: 0xcafe },
            { vendorId: 0x239A },
            { vendorId: 0x2FE3 }
        ];

        this.device = await navigator.usb.requestDevice({ filters });
        await this.device.open();

        if (this.device.reset) {
            await this.device.reset().catch(() => {});
        }

        await this.device.selectConfiguration(1);
        this.isNewFirmware = (this.device.vendorId === 0x2FE3);

        const interfaces = this.device.configuration.interfaces;
        let foundInterface = false;

        for (const iface of interfaces) {
            for (const alt of iface.alternates) {
                if (alt.interfaceClass === 0xFF) {
                    this.interfaceNumber = iface.interfaceNumber;
                    const inEps = alt.endpoints.filter(ep => ep.direction === "in").sort((a, b) => a.endpointNumber - b.endpointNumber);
                    const outEps = alt.endpoints.filter(ep => ep.direction === "out").sort((a, b) => a.endpointNumber - b.endpointNumber);

                    if (this.isNewFirmware && inEps.length >= 2 && outEps.length >= 2) {
                        this.cmdEndpointOut = outEps[0].endpointNumber;
                        this.cmdEndpointIn = inEps[0].endpointNumber;
                        this.endpointOut = outEps[1].endpointNumber;
                        this.endpointIn = inEps[1].endpointNumber;
                    } else {
                        if (outEps.length > 0) this.endpointOut = outEps[0].endpointNumber;
                        if (inEps.length > 0) this.endpointIn = inEps[0].endpointNumber;
                    }
                    foundInterface = true;
                    break;
                }
            }
            if (foundInterface) break;
        }

        if (!foundInterface) throw new Error("Could not find compatible interface");

        await this.device.claimInterface(this.interfaceNumber);
        await this.device.selectAlternateInterface(this.interfaceNumber, 0);

        if (!this.isNewFirmware) {
            await this.device.controlTransferOut({
                requestType: 'class', recipient: 'interface',
                request: 0x22, value: 0x01, index: this.interfaceNumber
            });
        }

        this.isConnected = true;
        await this.setVoltage('3v3');
        return true;
    }

    async disconnect() {
        if (this.device) {
            try {
                await this.device.releaseInterface(this.interfaceNumber);
                await this.device.close();
            } catch (e) {}
            this.device = null;
            this.isConnected = false;
            this.isNewFirmware = false;
        }
    }

    async sendCommand(bytes) {
        if (!this.isConnected) throw new Error("Not connected");
        const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (this.isNewFirmware && this.cmdEndpointOut) {
            await this.device.transferOut(this.cmdEndpointOut, buffer);
        } else {
            await this.device.transferOut(this.endpointOut, buffer);
        }
    }

    async writeBytes(data) {
        if (!this.isConnected) throw new Error("Not connected");
        const buffer = data instanceof Uint8Array ? data : new Uint8Array(data);
        await this.device.transferOut(this.endpointOut, buffer);
    }

    async readBytesRaw(length = 64, timeoutMs = 100) {
        if (!this.isConnected) throw new Error("Not connected");
        try {
            const result = await Promise.race([
                this.device.transferIn(this.endpointIn, length),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Read timeout")), timeoutMs))
            ]);
            if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
                return new Uint8Array(result.data.buffer);
            }
        } catch (e) {}
        return new Uint8Array(0);
    }

    async setVoltage(mode) {
        if (!this.isConnected) return;
        if (this.isNewFirmware) {
            const cmd = mode === '5v' ? CMD.SET_VOLTAGE_5V : CMD.SET_VOLTAGE_3V3;
            await this.sendCommand(new Uint8Array([cmd]));
        } else {
            if (!fwVersionAtLeast(this.device, 1, 0, 6)) return;
            const packet = mode === '5v' ? VSWITCH_5V_PACKET : VSWITCH_3V3_PACKET;
            await this.device.transferOut(this.endpointOut, packet);
            try {
                await Promise.race([
                    this.device.transferIn(this.endpointIn, 64),
                    new Promise((_, reject) => setTimeout(() => reject(), 500))
                ]);
            } catch (e) {}
        }
    }

    async setTimingConfig(usBetweenTransfer, bytesPerTransfer) {
        if (!this.isConnected) return;
        if (this.isNewFirmware) {
            const cmd = new Uint8Array([
                CMD.SET_TIMING_CONFIG,
                usBetweenTransfer & 0xFF,
                (usBetweenTransfer >> 8) & 0xFF,
                (usBetweenTransfer >> 16) & 0xFF,
                bytesPerTransfer & 0xFF
            ]);
            await this.sendCommand(cmd);
        } else {
            const config = new Uint8Array(36);
            config.set(MAGIC_PREFIX);
            config[32] = usBetweenTransfer & 0xFF;
            config[33] = (usBetweenTransfer >> 8) & 0xFF;
            config[34] = (usBetweenTransfer >> 16) & 0xFF;
            config[35] = bytesPerTransfer & 0xFF;
            await this.device.transferOut(this.endpointOut, config);
        }
    }

    async setMode(mode) {
        if (!this.isConnected) return;
        if (this.isNewFirmware) {
            await this.sendCommand(new Uint8Array([CMD.SET_MODE, mode]));
        }
    }
}

window.UsbConnection = UsbConnection;
window.CMD = CMD;
window.MODE = MODE;
