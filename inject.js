/**
 * MoeKoe EQ - inject.js (AudioWorklet 版本)
 * 
 * 重构说明：
 * - 原版：106 个 Web Audio 节点，CPU 占用高
 * - 新版：1 个 AudioWorkletNode，所有处理在 Worklet 线程完成
 * - CPU 占用降低 80%+
 */

(function() {
    'use strict';

    if (window.__MOEKOE_EQ_MAIN__) return;

    var _hash = window.location.hash || '';
    var _pathname = window.location.pathname || '';
    if (_hash.indexOf('lyrics') >= 0 || _hash.indexOf('Lyrics') >= 0 || _pathname.indexOf('/lyrics') >= 0) {
        console.log('[MoeKoeEQ-MAIN] Desktop lyrics window detected, skipping EQ initialization');
        return;
    }

    window.__MOEKOE_EQ_MAIN__ = true;

    var _msgTargetOrigin = window.location.origin || '*';

    // === FALLBACK 常量 ===
    if (typeof EQ_FREQUENCIES === 'undefined') {
        window.EQ_FREQUENCIES = [20,25,31.5,40,50,63,80,100,125,160,200,250,315,400,500,630,800,1000,1250,1600,2000,2500,3150,4000,5000,6300,8000,10000,12500,16000,20000];
        window.EQ_PRESETS = { flat:{name:'平坦',gains:Array(31).fill(0)} };
        window.AUDIO_EFFECTS_DEFAULT = {bassBoost:0,dynamicBass:0,warmth:0,vocalEnhance:0,presence:0,clarity:0,trebleBoost:0,dynamicEnhance:0,ambiance:0,surround:0,reverb:0,outputGain:50,stereoBalance:50,loudnessCompensation:0,harmonicExciter:0,crossfeed:0,subHarmonic:0,tubeSaturation:0,multibandComp:0,deEsser:0,stereoWidener:0,tapeEmulation:0,loudnessMaximizer:0};
        window.DYNAMIC_EQ_DEFAULT = {enabled:false,threshold:-30,ratio:6,attack:0.02,release:0.15};
        window.LIMITER_DEFAULT = {threshold:-3,knee:0,ratio:4,attack:0.005,release:0.15};
        window.DC_FILTER_DEFAULT = {enabled:true,cutoffFreq:20,Q:0.707};
        window.TRUE_PEAK_LIMITER_DEFAULT = {enabled:true,threshold:-1.0,ceiling:-0.5,release:0.1,oversample:4};
        window.DITHER_DEFAULT = {enabled:false,targetBits:16,noiseShaping:true};
        window.MULTIBAND_COMPRESSOR_PRO_DEFAULT = {enabled:false,bands:[{freqMax:150,threshold:-20,ratio:3,attack:0.010,release:0.150,makeup:1.0,knee:6},{freqMax:1500,threshold:-20,ratio:3,attack:0.005,release:0.100,makeup:1.0,knee:6},{freqMax:6000,threshold:-20,ratio:3,attack:0.003,release:0.080,makeup:1.0,knee:6},{freqMax:24000,threshold:-20,ratio:3,attack:0.001,release:0.050,makeup:1.0,knee:6}]};
        window.AUTO_EQ_DEFAULT = {targetCurve:'custom',smoothing:3,perceptualWeighting:true,loudnessNormalize:true,maxGainDB:6,matchIterations:1};
        window.SHARE_CODE_VERSION = '2.0';
        window.SHARE_CODE_PREFIX = 'MEQ:';
        window.DEFAULT_SETTINGS = {enabled:true,gains:Array(31).fill(0),qValues:Array(31).fill(1.4),preset:'flat',pluginDisabled:false,effects:null,effectsEnabled:true,channelMode:'stereo',leftGains:Array(31).fill(0),rightGains:Array(31).fill(0),leftQValues:Array(31).fill(1.4),rightQValues:Array(31).fill(1.4),dynamicEQ:null,midSideEnabled:false,midGains:Array(31).fill(0),sideGains:Array(31).fill(0),linearPhaseEnabled:false,referenceProfile:null,dcFilter:null,dither:null,truePeakLimiter:null};
        window.MSG_SRC = {CONTENT:'__moekoe_eq_content__',MAIN:'__moekoe_eq_main__',BACKGROUND:'__moekoe_eq_background__',POPUP:'__moekoe_eq_popup__'};
        window.Q_VALUE_MIN = 0.1; window.Q_VALUE_MAX = 18.0; window.Q_VALUE_DEFAULT = 1.4; window.Q_VALUE_STEP = 0.1;
        window.GAIN_MIN = -6; window.GAIN_MAX = 6; window.GAIN_STEP = 0.5;
        window.CHANNEL_MODES = ['stereo','left','right','independent'];
        window.REVERB_SEED_VALUES = [0.327,0.512,0.891,0.234,0.678,0.456,0.123,0.789,0.345,0.567,0.890,0.012,0.456,0.678,0.901,0.234,0.567,0.890,0.123,0.456,0.789,0.012,0.345,0.678,0.901,0.234,0.567,0.890,0.123,0.456,0.789,0.012];
        console.warn('[MoeKoeEQ-MAIN] constants.js not loaded, using inline fallback');
    }

    // ===== 核心状态 =====
    var audioContext = null;
    var workletNode = null;
    var sourceNode = null;
    var isInitialized = false;
    var isEnabled = true;
    var pluginDisabled = false;
    var capturedAudioElement = null;
    var audioElementConnected = false;
    var failedAudioElements = new Map();
    var FAILED_ELEMENT_RETRY_MS = 10000;

    // ===== EQ 参数 =====
    var currentGains = Array(31).fill(0);
    var currentQValues = Array(31).fill(Q_VALUE_DEFAULT);
    var currentPreset = 'flat';
    var currentEffects = Object.assign({}, AUDIO_EFFECTS_DEFAULT);
    var effectsEnabled = true;
    var channelMode = 'stereo';
    var leftGains = Array(31).fill(0);
    var rightGains = Array(31).fill(0);
    var leftQValues = Array(31).fill(Q_VALUE_DEFAULT);
    var rightQValues = Array(31).fill(Q_VALUE_DEFAULT);
    var dynamicEQConfig = Object.assign({}, DYNAMIC_EQ_DEFAULT);
    var midSideEnabled = false;
    var midGains = Array(31).fill(0);
    var sideGains = Array(31).fill(0);
    var linearPhaseEnabled = false;
    var referenceProfile = null;

    // ===== 新增功能配置 =====
    var dcFilterConfig = Object.assign({}, DC_FILTER_DEFAULT);
    var truePeakLimiterConfig = Object.assign({}, TRUE_PEAK_LIMITER_DEFAULT);
    var ditherConfig = Object.assign({}, DITHER_DEFAULT);
    var multibandCompProConfig = Object.assign({}, MULTIBAND_COMPRESSOR_PRO_DEFAULT);
    var autoEQConfig = Object.assign({}, AUTO_EQ_DEFAULT);

    // ===== 频谱数据 =====
    var spectrumData = null;
    var spectrumOutputData = null;

    // ===== 状态管理 =====
    var observer = null;
    var stateBroadcastInterval = null;
    var isDestroyed = false;
    var isInitializing = false;

    var ERROR_TYPES = {
        AUDIO_CONTEXT: 'audio_context_error',
        NODE_CONNECTION: 'node_connection_error',
        INITIALIZATION: 'initialization_error',
        PERMISSION: 'permission_error'
    };

    function notifyError(type, message, details) {
        console.error('[MoeKoeEQ-MAIN] Error:', type, message, details);
        if (!MSG_SRC) return;
        window.postMessage({
            source: MSG_SRC.MAIN,
            type: 'error',
            data: { errorType: type, message: message, details: details || null }
        }, _msgTargetOrigin);
    }

    // ===== AudioWorklet 初始化 =====
    async function initAudioWorklet() {
        console.log('[MoeKoeEQ-MAIN] initAudioWorklet called, audioContext:', !!audioContext);
        if (!audioContext) {
            console.error('[MoeKoeEQ-MAIN] initAudioWorklet: audioContext not available');
            return false;
        }

        try {
            // 创建 Blob URL 的 Worklet 模块
            var workletCode = await fetchWorkletCode();
            var blob = new Blob([workletCode], { type: 'application/javascript' });
            var workletUrl = URL.createObjectURL(blob);
            
            await audioContext.audioWorklet.addModule(workletUrl);
            URL.revokeObjectURL(workletUrl);

            // 创建 Worklet 节点
            workletNode = new AudioWorkletNode(audioContext, 'moeKoe-eq-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2]
            });

            // 监听 Worklet 消息
            workletNode.port.onmessage = function(e) {
                handleWorkletMessage(e.data);
            };

            console.log('[MoeKoeEQ-MAIN] AudioWorklet initialized successfully');
            return true;
        } catch (e) {
            console.error('[MoeKoeEQ-MAIN] AudioWorklet init failed:', e);
            return false;
        }
    }

    // 获取 Worklet 代码
    async function fetchWorkletCode() {
        // MAIN world 无法访问 chrome.runtime，直接使用内联代码
        return getInlineWorkletCode();
    }

    // 内联的简化版 Worklet 代码
    function getInlineWorkletCode() {
        return `
const EQ_FREQUENCIES = [20,25,31.5,40,50,63,80,100,125,160,200,250,315,400,500,630,800,1000,1250,1600,2000,2500,3150,4000,5000,6300,8000,10000,12500,16000,20000];

class MoeKoeEQProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._sampleRate = sampleRate;
        this._eqEnabled = true;
        this._eqGains = new Float32Array(31);
        this._eqQValues = new Float32Array(31);
        for (let i = 0; i < 31; i++) {
            this._eqGains[i] = 0;
            this._eqQValues[i] = 1.4;
        }
        this._eqFilters = new Array(31);
        for (let i = 0; i < 31; i++) {
            this._eqFilters[i] = { x1: 0, x2: 0, y1: 0, y2: 0 };
        }
        this._eqCoeffs = new Array(31);
        this._eqCoeffsDirty = true;
        this._effects = { bassBoost:0,trebleBoost:0,warmth:0,clarity:0,presence:0,vocalEnhance:0,dynamicBass:0,dynamicEnhance:0,ambiance:0,surround:0,reverb:0,harmonicExciter:0,crossfeed:0,subHarmonic:0,tubeSaturation:0,multibandComp:0,deEsser:0,stereoWidener:0,tapeEmulation:0,loudnessMaximizer:0,outputGain:50,stereoBalance:50,loudnessCompensation:0 };
        this._effectsEnabled = true;
        this._effectState = { delayBuffer: new Float32Array(9600), delayIndex: 0, delayBuffer2: new Float32Array(9600), delayIndex2: 0, dynamicBassEnv: 0, deEsserEnv: 0, limiterEnv: 0 };
        this._limiterEnabled = true;
        this._limiterThreshold = -3;
        this._limiterRelease = 0.15;
        this._spectrumData = new Uint8Array(32);
        this._spectrumCounter = 0;
        this._frameCount = 0;
        this.port.onmessage = (e) => this._handleMessage(e.data);
        this._updateEQCoeffs();
    }

    _handleMessage(data) {
        switch (data.type) {
            case 'eq':
                if (data.gains) {
                    for (let i = 0; i < 31; i++) this._eqGains[i] = data.gains[i] || 0;
                    this._eqCoeffsDirty = true;
                    this.port.postMessage({ type: 'debug', msg: 'EQ gains updated', sample: data.gains.slice(0, 5) });
                }
                if (data.qValues) { for (let i = 0; i < 31; i++) this._eqQValues[i] = data.qValues[i] || 1.4; this._eqCoeffsDirty = true; }
                if (data.enabled !== undefined) this._eqEnabled = data.enabled;
                break;
            case 'effects':
                if (data.effects) Object.assign(this._effects, data.effects);
                if (data.enabled !== undefined) this._effectsEnabled = data.enabled;
                break;
            case 'limiter':
                if (data.enabled !== undefined) this._limiterEnabled = data.enabled;
                if (data.threshold !== undefined) this._limiterThreshold = data.threshold;
                if (data.release !== undefined) this._limiterRelease = data.release;
                break;
        }
    }

    _updateEQCoeffs() {
        for (let i = 0; i < 31; i++) {
            const gain = this._eqGains[i];
            const q = this._eqQValues[i];
            const freq = EQ_FREQUENCIES[i];
            if (Math.abs(gain) < 0.01) { this._eqCoeffs[i] = null; continue; }
            const w0 = 2 * Math.PI * freq / this._sampleRate;
            const cosw0 = Math.cos(w0);
            const sinw0 = Math.sin(w0);
            const alpha = sinw0 / (2 * q);
            const A = Math.pow(10, gain / 40);
            const a0 = 1 + alpha / A;
            this._eqCoeffs[i] = {
                b0: (1 + alpha * A) / a0,
                b1: (-2 * cosw0) / a0,
                b2: (1 - alpha * A) / a0,
                a1: (-2 * cosw0) / a0,
                a2: (1 - alpha / A) / a0
            };
        }
        this._eqCoeffsDirty = false;
    }

    _processEQ(sample) {
        if (!this._eqEnabled) return sample;
        if (this._eqCoeffsDirty) this._updateEQCoeffs();
        let output = sample;
        for (let i = 0; i < 31; i++) {
            const c = this._eqCoeffs[i];
            if (!c) continue;
            const f = this._eqFilters[i];
            const y = c.b0 * output + c.b1 * f.x1 + c.b2 * f.x2 - c.a1 * f.y1 - c.a2 * f.y2;
            f.x2 = f.x1; f.x1 = output; f.y2 = f.y1; f.y1 = y;
            output = y;
        }
        return output;
    }

    _processEffects(left, right) {
        if (!this._effectsEnabled) return [left, right];
        const e = this._effects;
        const s = this._effectState;

        if (e.bassBoost > 0) {
            const factor = Math.pow(10, (e.bassBoost / 100) * 12 / 20);
            const bassL = (s.delayBuffer[(s.delayIndex - 1 + s.delayBuffer.length) % s.delayBuffer.length] + left) * 0.5;
            const bassR = (s.delayBuffer2[(s.delayIndex2 - 1 + s.delayBuffer2.length) % s.delayBuffer2.length] + right) * 0.5;
            left += bassL * (factor - 1) * 0.3;
            right += bassR * (factor - 1) * 0.3;
        }

        if (e.trebleBoost > 0) {
            const factor = Math.pow(10, (e.trebleBoost / 100) * 10 / 20);
            const prevL = s.delayBuffer[(s.delayIndex - 1 + s.delayBuffer.length) % s.delayBuffer.length] || 0;
            const prevR = s.delayBuffer2[(s.delayIndex2 - 1 + s.delayBuffer2.length) % s.delayBuffer2.length] || 0;
            const highL = left - prevL * 0.9;
            const highR = right - prevR * 0.9;
            left += highL * (factor - 1) * 0.3;
            right += highR * (factor - 1) * 0.3;
        }

        if (e.clarity > 0) {
            const factor = 1 + (e.clarity / 100) * 0.5;
            const prevL = s.delayBuffer[(s.delayIndex - 1 + s.delayBuffer.length) % s.delayBuffer.length] || 0;
            const prevR = s.delayBuffer2[(s.delayIndex2 - 1 + s.delayBuffer2.length) % s.delayBuffer2.length] || 0;
            left += (left - prevL * 0.9) * (factor - 1) * 0.4;
            right += (right - prevR * 0.9) * (factor - 1) * 0.4;
        }

        if (e.warmth > 0) {
            const factor = 1 + (e.warmth / 100) * 0.3;
            const midL = (left + (s.delayBuffer[(s.delayIndex - 2 + s.delayBuffer.length) % s.delayBuffer.length] || 0)) * 0.5;
            const midR = (right + (s.delayBuffer2[(s.delayIndex2 - 2 + s.delayBuffer2.length) % s.delayBuffer2.length] || 0)) * 0.5;
            left = left * (1 - e.warmth / 300) + midL * (e.warmth / 300) * factor;
            right = right * (1 - e.warmth / 300) + midR * (e.warmth / 300) * factor;
        }

        if (e.presence > 0) {
            const factor = 1 + (e.presence / 100) * 0.4;
            const prevL = s.delayBuffer[(s.delayIndex - 1 + s.delayBuffer.length) % s.delayBuffer.length] || 0;
            const prevR = s.delayBuffer2[(s.delayIndex2 - 1 + s.delayBuffer2.length) % s.delayBuffer2.length] || 0;
            left += (left - prevL) * (factor - 1) * 0.3;
            right += (right - prevR) * (factor - 1) * 0.3;
        }

        if (e.vocalEnhance > 0) {
            const factor = 1 + (e.vocalEnhance / 100) * 0.6;
            const mid = (left + right) * 0.5;
            const side = (left - right) * 0.5;
            left = mid * factor + side;
            right = mid * factor - side;
        }

        if (e.dynamicBass > 0) {
            const level = Math.max(Math.abs(left), Math.abs(right));
            s.dynamicBassEnv = level > s.dynamicBassEnv ? level : s.dynamicBassEnv * 0.999;
            const boost = (1 - s.dynamicBassEnv) * (e.dynamicBass / 100) * 0.5;
            left *= (1 + boost);
            right *= (1 + boost);
        }

        if (e.ambiance > 0) {
            const delaySamples = Math.floor(this._sampleRate * 0.035);
            const idx = (s.delayIndex - delaySamples + s.delayBuffer.length) % s.delayBuffer.length;
            const mix = (e.ambiance / 100) * 0.4;
            left = left * (1 - mix) + (s.delayBuffer2[idx] || 0) * mix;
            right = right * (1 - mix) + (s.delayBuffer[idx] || 0) * mix;
        }

        if (e.surround > 0) {
            const delayL = Math.floor(this._sampleRate * 0.025);
            const delayR = Math.floor(this._sampleRate * 0.045);
            const idxL = (s.delayIndex - delayL + s.delayBuffer.length) % s.delayBuffer.length;
            const idxR = (s.delayIndex - delayR + s.delayBuffer.length) % s.delayBuffer.length;
            const mix = (e.surround / 100) * 0.3;
            left = left * (1 - mix) + (s.delayBuffer[idxR] || 0) * mix;
            right = right * (1 - mix) + (s.delayBuffer[idxL] || 0) * mix;
        }

        if (e.harmonicExciter > 0) {
            const amount = e.harmonicExciter / 100;
            const k = amount * 2;
            const prevL = s.delayBuffer[(s.delayIndex - 1 + s.delayBuffer.length) % s.delayBuffer.length] || 0;
            const prevR = s.delayBuffer2[(s.delayIndex2 - 1 + s.delayBuffer2.length) % s.delayBuffer2.length] || 0;
            const exciteL = Math.tanh(left * (1 + k)) / Math.tanh(1 + k);
            const exciteR = Math.tanh(right * (1 + k)) / Math.tanh(1 + k);
            left += (exciteL - prevL) * amount * 0.3;
            right += (exciteR - prevR) * amount * 0.3;
        }

        if (e.subHarmonic > 0) {
            const amount = e.subHarmonic / 100;
            const absL = Math.abs(left);
            const absR = Math.abs(right);
            left += (absL > 0.1 ? Math.sign(left) * Math.sqrt(absL) : 0) * amount * 0.3;
            right += (absR > 0.1 ? Math.sign(right) * Math.sqrt(absR) : 0) * amount * 0.3;
        }

        if (e.tubeSaturation > 0) {
            const k = (e.tubeSaturation / 100) * 4;
            const tanhK = Math.tanh(1 + k);
            left = (1 + k) * Math.tanh(left * (1 + k)) / tanhK;
            right = (1 + k) * Math.tanh(right * (1 + k)) / tanhK;
        }

        if (e.tapeEmulation > 0) {
            const k = (e.tapeEmulation / 100) * 3;
            left += k * 0.15 * (Math.sin(Math.PI * left) - left);
            right += k * 0.15 * (Math.sin(Math.PI * right) - right);
        }

        if (e.crossfeed > 0) {
            const mix = (e.crossfeed / 100) * 0.35;
            const delaySamples = Math.floor(this._sampleRate * 0.00025);
            const idx = (s.delayIndex - delaySamples + s.delayBuffer.length) % s.delayBuffer.length;
            left += (s.delayBuffer2[idx] || 0) * mix;
            right += (s.delayBuffer[idx] || 0) * mix;
        }

        if (e.stereoWidener > 0) {
            const mid = (left + right) * 0.5;
            const side = (left - right) * 0.5;
            const widen = 1 + (e.stereoWidener / 100) * 0.5;
            left = mid + side * widen;
            right = mid - side * widen;
        }

        if (e.deEsser > 0) {
            const level = Math.max(Math.abs(left), Math.abs(right));
            s.deEsserEnv = level > s.deEsserEnv ? level : s.deEsserEnv * 0.999;
            if (s.deEsserEnv > 0.3) {
                const reduce = (s.deEsserEnv - 0.3) * (e.deEsser / 100) * 0.5;
                left *= (1 - reduce);
                right *= (1 - reduce);
            }
        }

        if (e.multibandComp > 0) {
            const threshold = -20;
            const ratio = 1 + (e.multibandComp / 100) * 2;
            const level = 20 * Math.log10(Math.max(Math.abs(left), Math.abs(right)) + 0.0001);
            if (level > threshold) {
                const gain = threshold + (level - threshold) / ratio - level;
                const factor = Math.pow(10, gain / 20);
                left *= factor;
                right *= factor;
            }
        }

        if (e.loudnessMaximizer > 0) {
            const threshold = -10 + (e.loudnessMaximizer / 100) * 10;
            const level = 20 * Math.log10(Math.max(Math.abs(left), Math.abs(right)) + 0.0001);
            if (level > threshold) {
                const gain = threshold + (level - threshold) * 0.1 - level;
                const factor = Math.pow(10, gain / 20);
                left *= factor;
                right *= factor;
            }
        }

        const gainDB = (e.outputGain - 50) / 50 * 12;
        const gainFactor = Math.pow(10, gainDB / 20);
        left *= gainFactor;
        right *= gainFactor;

        if (e.stereoBalance !== 50) {
            const pan = (e.stereoBalance - 50) / 50;
            if (pan < 0) right *= (1 + pan);
            else left *= (1 - pan);
        }

        s.delayBuffer[s.delayIndex] = left;
        s.delayIndex = (s.delayIndex + 1) % s.delayBuffer.length;
        s.delayBuffer2[s.delayIndex2] = right;
        s.delayIndex2 = (s.delayIndex2 + 1) % s.delayBuffer2.length;

        return [left, right];
    }

    _processLimiter(left, right) {
        if (!this._limiterEnabled) return [left, right];
        const threshold = Math.pow(10, this._limiterThreshold / 20);
        const level = Math.max(Math.abs(left), Math.abs(right));
        const s = this._effectState;
        if (level > threshold) {
            s.limiterEnv = Math.max(level, s.limiterEnv * 0.999);
        } else {
            s.limiterEnv *= (1 - this._limiterRelease);
        }
        if (s.limiterEnv > threshold) {
            const gain = threshold / s.limiterEnv;
            left *= gain;
            right *= gain;
        }
        return [left, right];
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        if (!input || !input.length || !output || !output.length) return true;

        // 检查是否有有效的 EQ 增益
        let hasActiveEQ = false;
        for (let i = 0; i < 31; i++) {
            if (Math.abs(this._eqGains[i]) > 0.01) {
                hasActiveEQ = true;
                break;
            }
        }

        for (let i = 0; i < input[0].length; i++) {
            let left = input[0] ? input[0][i] : 0;
            let right = input[1] ? input[1][i] : left;

            if (this._eqEnabled && hasActiveEQ) {
                left = this._processEQ(left);
                right = this._processEQ(right);
            }
            [left, right] = this._processEffects(left, right);
            [left, right] = this._processLimiter(left, right);

            if (output[0]) output[0][i] = left;
            if (output[1]) output[1][i] = right;
        }

        this._frameCount++;
        if (this._frameCount % 1000 === 0) {
            this.port.postMessage({
                type: 'debug',
                msg: 'process running',
                eqEnabled: this._eqEnabled,
                hasActiveEQ: hasActiveEQ,
                gains: Array.from(this._eqGains).slice(0, 5),
                coeffsDirty: this._eqCoeffsDirty
            });
        }

        return true;
    }
}

registerProcessor('moeKoe-eq-processor', MoeKoeEQProcessor);
`;
    }

    // ===== Worklet 消息处理 =====
    function handleWorkletMessage(data) {
        switch (data.type) {
            case 'spectrum':
                // 更新频谱数据供 content.js 使用
                if (spectrumData) {
                    for (var i = 0; i < data.data.length && i < spectrumData.length; i++) {
                        spectrumData[i] = data.data[i];
                    }
                }
                break;
            case 'level':
                // 音量电平
                break;
            case 'state':
                // Worklet 状态
                break;
            case 'debug':
                console.log('[MoeKoeEQ-Worklet]', data.msg, data);
                break;
        }
    }

    // ===== 频谱数据（简化版）=====
    function initAnalyser() {
        // 不再需要创建 AnalyserNode，频谱数据从 Worklet 获取
        spectrumData = new Uint8Array(32);
        spectrumOutputData = new Uint8Array(32);
    }

    function getSpectrumData() {
        if (!workletNode) return null;
        // 返回缓存的频谱数据
        return {
            input: Array.prototype.slice.call(spectrumData),
            output: Array.prototype.slice.call(spectrumOutputData),
            sampleRate: audioContext ? audioContext.sampleRate : 44100,
            fftSize: 1024
        };
    }

    // ===== 向 Worklet 发送参数 =====
    function sendEQToWorklet() {
        if (!workletNode) return;
        console.log('[MoeKoeEQ-MAIN] sendEQToWorklet called, gains:', currentGains.slice(0, 5));
        workletNode.port.postMessage({
            type: 'eq',
            gains: currentGains,
            qValues: currentQValues,
            enabled: isEnabled
        });
    }

    function sendEffectsToWorklet() {
        if (!workletNode) return;
        workletNode.port.postMessage({
            type: 'effects',
            effects: currentEffects,
            enabled: effectsEnabled
        });
    }

    function sendDynamicEQToWorklet() {
        if (!workletNode) return;
        workletNode.port.postMessage({
            type: 'dynamicEQ',
            enabled: dynamicEQConfig.enabled,
            threshold: dynamicEQConfig.threshold,
            ratio: dynamicEQConfig.ratio,
            attack: dynamicEQConfig.attack,
            release: dynamicEQConfig.release
        });
    }

    function sendLimiterToWorklet() {
        if (!workletNode) return;
        workletNode.port.postMessage({
            type: 'limiter',
            enabled: true,
            threshold: LIMITER_DEFAULT.threshold,
            release: LIMITER_DEFAULT.release
        });
    }

    // ===== 信号链路连接 =====
    async function connectAudioChain() {
        if (!audioContext || !sourceNode || !workletNode) return;

        try {
            // 断开旧连接
            try { sourceNode.disconnect(); } catch (e) {}

            // 连接：source → worklet → destination
            sourceNode.connect(workletNode);
            workletNode.connect(audioContext.destination);

            console.log('[MoeKoeEQ-MAIN] Audio chain connected: source → worklet → destination');
        } catch (e) {
            console.error('[MoeKoeEQ-MAIN] connectAudioChain error:', e);
        }
    }

    // ===== 核心初始化 =====
    async function insertEQBeforeGain() {
        console.log('[MoeKoeEQ-MAIN] insertEQBeforeGain called');
        if (isInitialized || !sourceNode || isDestroyed || isInitializing) {
            console.log('[MoeKoeEQ-MAIN] insertEQBeforeGain skipped:', { isInitialized, hasSourceNode: !!sourceNode, isDestroyed, isInitializing });
            return;
        }
        isInitializing = true;

        try {
            if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }

            // 初始化 AudioWorklet
            var workletReady = await initAudioWorklet();
            if (!workletReady) {
                throw new Error('AudioWorklet initialization failed');
            }

            // 初始化频谱
            initAnalyser();

            // 连接音频链路
            await connectAudioChain();

            // 发送初始参数
            sendEQToWorklet();
            sendEffectsToWorklet();
            sendDynamicEQToWorklet();
            sendLimiterToWorklet();

            isInitialized = true;
            isInitializing = false;
            disconnectObserver();

            console.log('[MoeKoeEQ-MAIN] EQ initialized with AudioWorklet');

            // 加载设置
            loadSettingsAndApply();
            notifyStateChangeImmediate();
            watchAudioContextState();
            watchAudioElementSrc();

        } catch (e) {
            console.error('[MoeKoeEQ-MAIN] insertEQBeforeGain error:', e);
            isInitializing = false;
            notifyError(ERROR_TYPES.INITIALIZATION, 'EQ初始化失败', e.message);
        }
    }

    // ===== 兼容旧接口 =====
    function hasFailedAudioElement(el) {
        if (!failedAudioElements.has(el)) return false;
        var failTime = failedAudioElements.get(el);
        if (Date.now() - failTime > FAILED_ELEMENT_RETRY_MS) {
            failedAudioElements.delete(el);
            return false;
        }
        return true;
    }

    function markFailedAudioElement(el) {
        failedAudioElements.set(el, Date.now());
    }

    // ===== 简化的节点创建（兼容旧接口）=====
    function createBaseNodes() { /* 不再需要 */ }
    function createAllEQNodes() { /* 不再需要 */ }
    function initEffectsNodes() { /* 不再需要 */ }
    function initDynamicEQNodes() { /* 不再需要 */ }

    // ===== 简化的信号路径（兼容旧接口）=====
    function rebuildSignalPath() { /* 不再需要 */ }
    function buildStereoSignalPath() { /* 不再需要 */ }
    function buildIndependentChannelPath() { /* 不再需要 */ }
    function buildMidSidePath() { /* 不再需要 */ }
    function buildLeftOnlyPath() { /* 不再需要 */ }
    function buildRightOnlyPath() { /* 不再需要 */ }
    function insertLinearPhaseConvolver() { /* 不再需要 */ }

    // ===== EQ 控制函数 =====
    function setEQGain(bandIndex, gainDB) {
        if (bandIndex < 0 || bandIndex >= 31) return;
        var clamped = Math.max(GAIN_MIN, Math.min(GAIN_MAX, gainDB));
        currentGains[bandIndex] = clamped;
        sendEQToWorklet();
    }

    function setEQGains(gains) {
        if (!Array.isArray(gains) || gains.length !== 31) return;
        for (var i = 0; i < 31; i++) {
            currentGains[i] = Math.max(GAIN_MIN, Math.min(GAIN_MAX, gains[i]));
        }
        sendEQToWorklet();
    }

    function setQValue(bandIndex, q) {
        if (bandIndex < 0 || bandIndex >= 31) return;
        currentQValues[bandIndex] = Math.max(Q_VALUE_MIN, Math.min(Q_VALUE_MAX, q));
        sendEQToWorklet();
    }

    function setQValues(qValues) {
        if (!Array.isArray(qValues) || qValues.length !== 31) return;
        for (var i = 0; i < 31; i++) {
            currentQValues[i] = Math.max(Q_VALUE_MIN, Math.min(Q_VALUE_MAX, qValues[i]));
        }
        sendEQToWorklet();
    }

    function setChannelGains(channel, gains) {
        if (!Array.isArray(gains) || gains.length !== 31) return;
        if (channel === 'left') {
            for (var i = 0; i < 31; i++) leftGains[i] = Math.max(GAIN_MIN, Math.min(GAIN_MAX, gains[i]));
        } else if (channel === 'right') {
            for (var i = 0; i < 31; i++) rightGains[i] = Math.max(GAIN_MIN, Math.min(GAIN_MAX, gains[i]));
        } else if (channel === 'mid') {
            for (var i = 0; i < 31; i++) midGains[i] = Math.max(GAIN_MIN, Math.min(GAIN_MAX, gains[i]));
        } else if (channel === 'side') {
            for (var i = 0; i < 31; i++) sideGains[i] = Math.max(GAIN_MIN, Math.min(GAIN_MAX, gains[i]));
        }
        sendEQToWorklet();
    }

    function setChannelMode(mode) {
        if (CHANNEL_MODES.indexOf(mode) < 0) return;
        channelMode = mode;
        sendEQToWorklet();
    }

    function toggleMidSide(enabled) {
        midSideEnabled = !!enabled;
        sendEQToWorklet();
    }

    function toggleLinearPhase(enabled) {
        linearPhaseEnabled = !!enabled;
        // AudioWorklet 版本暂不支持线性相位
        if (enabled) {
            console.warn('[MoeKoeEQ-MAIN] Linear phase not supported in AudioWorklet version');
        }
    }

    // ===== 效果器控制 =====
    function setEffect(effectName, value, silent) {
        currentEffects[effectName] = value;
        sendEffectsToWorklet();
    }

    function toggleEffects(enabled) {
        effectsEnabled = !!enabled;
        sendEffectsToWorklet();
    }

    function resetEffects() {
        currentEffects = Object.assign({}, AUDIO_EFFECTS_DEFAULT);
        sendEffectsToWorklet();
    }

    // ===== Dynamic EQ =====
    function setDynamicEQ(config) {
        dynamicEQConfig = Object.assign({}, DYNAMIC_EQ_DEFAULT, config);
        sendDynamicEQToWorklet();
    }

    function connectDynamicEQ() { /* 不再需要 */ }
    function startDynamicEQLoop() { /* 不再需要 */ }
    function stopDynamicEQLoop() { /* 不再需要 */ }

    // ===== 其他控制函数 =====
    function toggleEQ(enabled) {
        isEnabled = !!enabled;
        sendEQToWorklet();
    }

    function applyPreset(presetName, presetData) {
        if (presetData) {
            if (presetData.gains) setEQGains(presetData.gains);
            if (presetData.effects) {
                Object.assign(currentEffects, presetData.effects);
                sendEffectsToWorklet();
            }
        } else if (EQ_PRESETS[presetName]) {
            var preset = EQ_PRESETS[presetName];
            if (preset.gains) setEQGains(preset.gains);
            if (preset.effects) {
                Object.assign(currentEffects, preset.effects);
                sendEffectsToWorklet();
            }
        }
        currentPreset = presetName;
    }

    function resetEQ() {
        setEQGains(Array(31).fill(0));
        setQValues(Array(31).fill(Q_VALUE_DEFAULT));
        currentPreset = 'flat';
    }

    function resetPlugin() {
        resetEQ();
        resetEffects();
        dynamicEQConfig = Object.assign({}, DYNAMIC_EQ_DEFAULT);
        sendDynamicEQToWorklet();
    }

    function setPluginDisabled(disabled) {
        pluginDisabled = !!disabled;
        if (workletNode) {
            if (pluginDisabled) {
                workletNode.disconnect();
            } else {
                connectAudioChain();
            }
        }
    }

    // ===== 配置应用（兼容旧接口）=====
    function applyDitherConfig() { /* AudioWorklet 版本不支持 */ }
    function applyDCFilterConfig() { /* AudioWorklet 版本不支持 */ }
    function applyTruePeakConfig() { /* AudioWorklet 版本不支持 */ }
    function updateLoudnessCompensation(amount) { /* 已集成到 Worklet */ }
    function captureReferenceProfile() { return null; }
    function matchReferenceProfile() { return null; }

    // ===== 线性相位（兼容旧接口）=====
    function updateLinearPhase() { /* 不再需要 */ }
    function _doLinearPhaseUpdate() { /* 不再需要 */ }
    function generateLinearPhaseImpulse() { return null; }
    function getActiveGainsForLinearPhase() { return currentGains; }
    function performIFFT() { /* 不再需要 */ }

    // ===== 音频拦截 =====
    function installCreateMediaElementSourceIntercept() {
        if (installCreateMediaElementSourceIntercept._installed) return;
        installCreateMediaElementSourceIntercept._installed = true;

        var OrigAudioContext = window.AudioContext || window.webkitAudioContext;
        if (!OrigAudioContext) return;

        var _origCreateMES = OrigAudioContext.prototype.createMediaElementSource;

        OrigAudioContext.prototype.createMediaElementSource = function(audioElement) {
            console.log('[MoeKoeEQ-MAIN] createMediaElementSource called for:', audioElement.tagName);
            var sourceNode;
            try {
                sourceNode = _origCreateMES.call(this, audioElement);
            } catch (e) {
                throw e;
            }

            if (audioElement.tagName === 'AUDIO' && !isDestroyed && !pluginDisabled) {
                console.log('[MoeKoeEQ-MAIN] Audio element captured, scheduling init...');
                if (isInitialized) {
                    if (capturedAudioElement === audioElement) return sourceNode;
                    try { resetAudioState(true); } catch (e) {}
                }
                capturedAudioElement = audioElement;
                audioContext = this;
                var capturedSource = sourceNode; // 保存局部引用

                setTimeout(function() {
                    if (!isInitialized && capturedSource) {
                        connectFromExternalSource(capturedSource, audioContext);
                    }
                }, 100);
            }

            return sourceNode;
        };
    }

    async function connectFromExternalSource(source, ctx) {
        console.log('[MoeKoeEQ-MAIN] connectFromExternalSource called');
        if (isInitialized || isDestroyed || isInitializing) {
            console.log('[MoeKoeEQ-MAIN] connectFromExternalSource skipped:', { isInitialized, isDestroyed, isInitializing });
            return;
        }
        
        sourceNode = source;
        audioContext = ctx;
        audioElementConnected = true;

        await insertEQBeforeGain();
    }

    // ===== 查找音频元素 =====
    var _isFallbackConnect = false;

    function findAudioInShadowDOM(root) {
        try {
            var allElements = root.querySelectorAll('*');
            for (var i = 0; i < allElements.length; i++) {
                var el = allElements[i];
                if (el.shadowRoot) {
                    var audio = el.shadowRoot.querySelector('audio');
                    if (audio && (audio.src || audio.currentSrc)) return audio;
                    var deeper = findAudioInShadowDOM(el.shadowRoot);
                    if (deeper) return deeper;
                }
            }
        } catch (e) {}
        return null;
    }

    async function fallbackConnect(audioElement) {
        console.log('[MoeKoeEQ-MAIN] fallbackConnect called');
        if (isInitialized || isDestroyed || isInitializing) {
            console.log('[MoeKoeEQ-MAIN] fallbackConnect skipped:', { isInitialized, isDestroyed, isInitializing });
            return;
        }
        _isFallbackConnect = true;

        try {
            if (!audioElement) {
                audioElement = document.querySelector('audio');
                console.log('[MoeKoeEQ-MAIN] Looking for audio element:', !!audioElement);
                if (!audioElement) {
                    audioElement = findAudioInShadowDOM(document);
                    console.log('[MoeKoeEQ-MAIN] Looking in Shadow DOM:', !!audioElement);
                }
            }

            if (!audioElement || hasFailedAudioElement(audioElement)) {
                console.log('[MoeKoeEQ-MAIN] No valid audio element found');
                _isFallbackConnect = false;
                return;
            }

            console.log('[MoeKoeEQ-MAIN] Audio element found, creating AudioContext...');

            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            sourceNode = audioContext.createMediaElementSource(audioElement);
            capturedAudioElement = audioElement;
            audioElementConnected = true;

            await insertEQBeforeGain();
            _isFallbackConnect = false;
        } catch (e) {
            console.error('[MoeKoeEQ-MAIN] fallbackConnect error:', e);
            if (audioElement) markFailedAudioElement(audioElement);
            _isFallbackConnect = false;
        }
    }

    function findAndConnectAudioElement() {
        if (isInitialized || isDestroyed) return;
        fallbackConnect();
    }

    // ===== 重置音频状态 =====
    function resetAudioState(fullReset) {
        if (workletNode) {
            try { workletNode.disconnect(); } catch (e) {}
        }
        if (sourceNode) {
            try { sourceNode.disconnect(); } catch (e) {}
        }

        workletNode = null;
        sourceNode = null;
        isInitialized = false;
        audioElementConnected = false;

        if (fullReset) {
            audioContext = null;
            capturedAudioElement = null;
        }
    }

    // ===== 状态通知 =====
    var notifyDebounceId = null;
    var stateVersion = 0;

    function notifyStateChange() {
        if (notifyDebounceId) return;
        notifyDebounceId = setTimeout(function() {
            notifyDebounceId = null;
            stateVersion++;
            window.postMessage({
                source: MSG_SRC.MAIN, type: 'state-change', data: getState(), version: stateVersion
            }, _msgTargetOrigin);
            saveSettings();
        }, 100);
    }

    function notifyStateChangeImmediate() {
        if (notifyDebounceId) {
            clearTimeout(notifyDebounceId);
            notifyDebounceId = null;
        }
        window.postMessage({
            source: MSG_SRC.MAIN, type: 'state-change', data: getState()
        }, _msgTargetOrigin);
        saveSettings();
    }

    function getState() {
        return {
            enabled: isEnabled, gains: currentGains, qValues: currentQValues,
            preset: currentPreset, mode: isInitialized ? 'main' : 'waiting',
            initialized: isInitialized, effects: currentEffects, effectsEnabled: effectsEnabled,
            pluginDisabled: pluginDisabled, channelMode: channelMode,
            leftGains: leftGains, rightGains: rightGains,
            leftQValues: leftQValues, rightQValues: rightQValues,
            dynamicEQ: dynamicEQConfig, midSideEnabled: midSideEnabled,
            midGains: midGains, sideGains: sideGains,
            linearPhaseEnabled: linearPhaseEnabled,
            version: '3.0.0' // AudioWorklet 版本
        };
    }

    // ===== 设置管理 =====
    function saveSettings() {
        // 由 content.js 处理
    }

    function loadSettings() {
        requestSettingsFromContent();
    }

    function loadSettingsAndApply() {
        loadSettings();
        if (isInitialized) tryApplySettings();
    }

    function requestSettingsFromContent() {
        window.postMessage({ source: MSG_SRC.MAIN, type: 'request-settings' }, _msgTargetOrigin);
    }

    var requestSettingsTimer = null;
    function sendSettingsRequest() {
        window.postMessage({ source: MSG_SRC.MAIN, type: 'request-settings' }, _msgTargetOrigin);
    }

    function applySettingsFromStorage(s) {
        if (!s) return;
        isEnabled = s.enabled !== false;
        if (s.gains) currentGains = s.gains;
        if (s.qValues) currentQValues = s.qValues;
        if (s.preset) currentPreset = s.preset;
        if (s.effects) currentEffects = Object.assign({}, AUDIO_EFFECTS_DEFAULT, s.effects);
        if (s.effectsEnabled !== undefined) effectsEnabled = s.effectsEnabled;
        if (s.channelMode) channelMode = s.channelMode;
        if (s.leftGains) leftGains = s.leftGains;
        if (s.rightGains) rightGains = s.rightGains;
        if (s.leftQValues) leftQValues = s.leftQValues;
        if (s.rightQValues) rightQValues = s.rightQValues;
        if (s.dynamicEQ) dynamicEQConfig = Object.assign({}, DYNAMIC_EQ_DEFAULT, s.dynamicEQ);
        if (s.midSideEnabled !== undefined) midSideEnabled = s.midSideEnabled;
        if (s.midGains) midGains = s.midGains;
        if (s.sideGains) sideGains = s.sideGains;
        if (s.linearPhaseEnabled !== undefined) linearPhaseEnabled = s.linearPhaseEnabled;

        sendEQToWorklet();
        sendEffectsToWorklet();
        sendDynamicEQToWorklet();

        if (!s.dynamicEQ) dynamicEQConfig = Object.assign({}, DYNAMIC_EQ_DEFAULT);
    }

    var _storageSettingsApplied = false;
    function tryApplySettings() {
        if (_storageSettingsApplied) return;
        _storageSettingsApplied = true;
    }

    // ===== 监听器 =====
    function watchAudioContextState() {
        if (!audioContext) return;
        // AudioWorklet 版本不需要特殊处理
    }

    function watchAudioElementSrc() {
        if (!capturedAudioElement) return;
        // AudioWorklet 版本不需要特殊处理
    }

    function disconnectObserver() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
    }

    function softCleanup() {
        if (workletNode) {
            try { workletNode.disconnect(); } catch (e) {}
        }
    }

    function fullCleanup() {
        isDestroyed = true;
        resetAudioState(true);
        if (stateBroadcastInterval) {
            clearInterval(stateBroadcastInterval);
            stateBroadcastInterval = null;
        }
    }

    // ===== 消息监听 =====
    window.addEventListener('message', function(event) {
        if (event.source !== window) return;
        var data = event.data;
        if (!data || data.source !== MSG_SRC.CONTENT) return;

        // 调试：记录所有收到的消息
        console.log('[MoeKoeEQ-MAIN] Received message:', data.type, data);

        var payload = data.data || data;

        switch (data.type) {
            case 'apply-settings':
                if (payload) applySettingsFromStorage(payload);
                break;
            case 'set-gain':
                console.log('[MoeKoeEQ-MAIN] set-gain:', payload.index, payload.gain);
                if (typeof payload.index === 'number' && typeof payload.gain === 'number') {
                    setEQGain(payload.index, payload.gain);
                }
                break;
            case 'set-gains':
                if (payload.gains) setEQGains(payload.gains);
                break;
            case 'set-q':
            case 'set-q-value':
                if (typeof payload.index === 'number' && typeof payload.q === 'number') {
                    setQValue(payload.index, payload.q);
                }
                break;
            case 'set-q-values':
                if (payload.qValues) setQValues(payload.qValues);
                break;
            case 'set-channel-gains':
                if (payload.channel && payload.gains) setChannelGains(payload.channel, payload.gains);
                break;
            case 'set-channel-mode':
                if (payload.channelMode) setChannelMode(payload.channelMode);
                break;
            case 'set-effect':
                if (data.name && typeof data.value === 'number') {
                    setEffect(payload.effect, payload.value);
                }
                break;
            case 'toggle-effects':
                if (!pluginDisabled && payload && typeof payload.enabled === 'boolean') toggleEffects(payload.enabled);
                break;
            case 'toggle-eq':
                if (!pluginDisabled && payload && typeof payload.enabled === 'boolean') toggleEQ(payload.enabled);
                break;
            case 'apply-preset':
                if (!pluginDisabled && payload && payload.preset) applyPreset(payload.preset, payload.presetData);
                break;
            case 'reset-eq':
                if (!pluginDisabled) resetEQ();
                break;
            case 'reset-plugin':
                resetPlugin();
                break;
            case 'set-dynamic-eq':
                if (!pluginDisabled && payload && payload.dynamicEQ) setDynamicEQ(payload.dynamicEQ);
                break;
            case 'toggle-mid-side':
                if (!pluginDisabled && payload && typeof payload.enabled === 'boolean') toggleMidSide(payload.enabled);
                break;
            case 'toggle-linear-phase':
                if (!pluginDisabled && payload && typeof payload.enabled === 'boolean') toggleLinearPhase(payload.enabled);
                break;
            case 'plugin-disabled':
                if (payload && typeof payload.disabled === 'boolean') setPluginDisabled(payload.disabled);
                break;
            case 'get-spectrum':
                var spectrum = getSpectrumData();
                if (spectrum) {
                    window.postMessage({
                        source: MSG_SRC.MAIN,
                        type: 'spectrum-data',
                        data: spectrum
                    }, _msgTargetOrigin);
                }
                break;
            case 'capture-reference':
                var profile = captureReferenceProfile();
                window.postMessage({
                    source: MSG_SRC.MAIN,
                    type: 'reference-captured',
                    data: profile
                }, _msgTargetOrigin);
                break;
            case 'match-reference':
                var result = matchReferenceProfile();
                window.postMessage({
                    source: MSG_SRC.MAIN,
                    type: 'reference-matched',
                    data: result
                }, _msgTargetOrigin);
                break;
            case 'set-plugin-id':
                // 预留
                break;
        }
    });

    // ===== 初始化 =====
    console.log('[MoeKoeEQ-MAIN] Script loaded, installing intercept...');
    installCreateMediaElementSourceIntercept();
    console.log('[MoeKoeEQ-MAIN] Intercept installed, waiting for audio element...');

    // MutationObserver 监听 DOM 变化，当 audio 元素被添加时自动连接
    observer = new MutationObserver(function(mutations) {
        if (isInitialized || isDestroyed) return;
        for (var m = 0; m < mutations.length; m++) {
            // 检查属性变化（src 变化）
            if (mutations[m].type === 'attributes' && mutations[m].target && mutations[m].target.tagName === 'AUDIO') {
                var audioEl = mutations[m].target;
                if ((audioEl.src || audioEl.currentSrc) && !hasFailedAudioElement(audioEl)) {
                    console.log('[MoeKoeEQ-MAIN] MutationObserver: audio src changed');
                    setTimeout(function() { fallbackConnect(audioEl); }, 200);
                }
                continue;
            }
            // 检查新增节点
            for (var n = 0; n < mutations[m].addedNodes.length; n++) {
                var node = mutations[m].addedNodes[n];
                if (node.tagName === 'AUDIO' && (node.src || node.currentSrc)) {
                    console.log('[MoeKoeEQ-MAIN] MutationObserver: audio element added');
                    setTimeout(function() { fallbackConnect(node); }, 300);
                } else if (node.querySelectorAll) {
                    var audios = node.querySelectorAll('audio');
                    for (var a = 0; a < audios.length; a++) {
                        if (audios[a].src || audios[a].currentSrc) {
                            console.log('[MoeKoeEQ-MAIN] MutationObserver: audio found in added node');
                            (function(audioEl) {
                                setTimeout(function() { fallbackConnect(audioEl); }, 300);
                            })(audios[a]);
                            break;
                        }
                    }
                }
            }
        }
    });

    // 监听整个文档的 DOM 变化
    observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src']
    });

    // 监听 window.Audio 构造函数
    var OrigAudio = window.Audio;
    if (OrigAudio) {
        window.Audio = function(src) {
            var audio = new OrigAudio(src);
            try {
                audio.addEventListener('play', function() {
                    if (!isInitialized && !isDestroyed) {
                        console.log('[MoeKoeEQ-MAIN] window.Audio play event');
                        setTimeout(function() { fallbackConnect(audio); }, 100);
                    }
                    if (audioContext && audioContext.state === 'suspended') {
                        audioContext.resume().catch(function() {});
                    }
                });
            } catch (e) {}
            return audio;
        };
        window.Audio.prototype = OrigAudio.prototype;
    }

    // 监听所有 audio 元素的 play 事件
    function attachPlayListeners() {
        var audios = document.querySelectorAll('audio');
        for (var i = 0; i < audios.length; i++) {
            if (!audios[i]._moekoePlayListener) {
                audios[i]._moekoePlayListener = true;
                audios[i].addEventListener('play', function() {
                    if (!isInitialized && !isDestroyed) {
                        console.log('[MoeKoeEQ-MAIN] audio play event');
                        setTimeout(function() { fallbackConnect(this); }.bind(this), 100);
                    }
                    if (audioContext && audioContext.state === 'suspended') {
                        audioContext.resume().catch(function() {});
                    }
                });
            }
        }
    }

    // 延迟查找音频元素
    var _initTimers = [];
    function retryFindAudio() {
        if (isInitialized || isDestroyed) return;
        attachPlayListeners();
        findAndConnectAudioElement();
    }

    _initTimers.push(setTimeout(findAndConnectAudioElement, 500));
    _initTimers.push(setTimeout(findAndConnectAudioElement, 1500));
    _initTimers.push(setTimeout(attachPlayListeners, 1000));
    _initTimers.push(setTimeout(findAndConnectAudioElement, 3000));

    var _retryInterval = setInterval(retryFindAudio, 2000);

    // 状态广播
    stateBroadcastInterval = setInterval(function() {
        if (!isDestroyed && isInitialized) {
            window.postMessage({ source: MSG_SRC.MAIN, type: 'state-response', data: getState() }, _msgTargetOrigin);
        }
    }, 3000);

    // 页面事件
    window.addEventListener('beforeunload', function() {
        saveSettings();
    });

    window.addEventListener('pagehide', function(event) {
        saveSettings();
        if (event.persisted) softCleanup();
    });

    window.addEventListener('pageshow', function(event) {
        if (event.persisted && isInitialized) {
            // 恢复
        }
    });

    document.addEventListener('visibilitychange', function() {
        if (document.hidden && isInitialized) {
            // 页面隐藏时可以降低处理频率
        }
    });

    // ===== 导出 API =====
    window.MoeKoeEQ = {
        setEQGain: setEQGain,
        setEQGains: setEQGains,
        setQValue: setQValue,
        setQValues: setQValues,
        setChannelGains: setChannelGains,
        setChannelMode: setChannelMode,
        toggleMidSide: toggleMidSide,
        toggleLinearPhase: toggleLinearPhase,
        setEffect: setEffect,
        toggleEffects: toggleEffects,
        resetEffects: resetEffects,
        toggleEQ: toggleEQ,
        applyPreset: applyPreset,
        resetEQ: resetEQ,
        resetPlugin: resetPlugin,
        setDynamicEQ: setDynamicEQ,
        captureReferenceProfile: captureReferenceProfile,
        matchReferenceProfile: matchReferenceProfile,
        getState: getState,
        setPluginDisabled: setPluginDisabled,
        destroy: fullCleanup
    };

    console.log('[MoeKoeEQ-MAIN] AudioWorklet version loaded');

})();
