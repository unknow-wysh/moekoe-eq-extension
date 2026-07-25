/**
 * MoeKoe EQ - inject.js (AudioWorklet 简化版)
 * 
 * 只保留核心 EQ 功能，彻底解决爆音问题
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
            // 创建简化版 Worklet 代码
            var workletCode = `
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
                    // 重置滤波器状态
                    for (let i = 0; i < 31; i++) {
                        this._eqFilters[i] = { x1: 0, x2: 0, y1: 0, y2: 0 };
                    }
                }
                if (data.qValues) { for (let i = 0; i < 31; i++) this._eqQValues[i] = data.qValues[i] || 1.4; this._eqCoeffsDirty = true; }
                if (data.enabled !== undefined) this._eqEnabled = data.enabled;
                break;
            case 'effects':
                // 简化版不处理效果器
                break;
            case 'limiter':
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
            if (isNaN(y) || !isFinite(y)) {
                f.x1 = 0; f.x2 = 0; f.y1 = 0; f.y2 = 0;
                continue;
            }
            f.x2 = f.x1; f.x1 = output; f.y2 = f.y1; f.y1 = y;
            output = y;
        }
        // 限幅保护
        output = Math.max(-1, Math.min(1, output));
        return output;
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        if (!input || !input.length || !output || !output.length) return true;

        for (let i = 0; i < input[0].length; i++) {
            let left = input[0] ? input[0][i] : 0;
            let right = input[1] ? input[1][i] : left;

            left = this._processEQ(left);
            right = this._processEQ(right);

            if (output[0]) output[0][i] = left;
            if (output[1]) output[1][i] = right;
        }

        this._frameCount++;
        return true;
    }
}

registerProcessor('moeKoe-eq-processor', MoeKoeEQProcessor);
`;

            var blob = new Blob([workletCode], { type: 'application/javascript' });
            var workletUrl = URL.createObjectURL(blob);
            
            await audioContext.audioWorklet.addModule(workletUrl);
            URL.revokeObjectURL(workletUrl);

            workletNode = new AudioWorkletNode(audioContext, 'moeKoe-eq-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2]
            });

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

    function handleWorkletMessage(data) {
        // 简化版不处理 Worklet 消息
    }

    function initAnalyser() {
        spectrumData = new Uint8Array(32);
        spectrumOutputData = new Uint8Array(32);
    }

    function getSpectrumData() {
        if (!workletNode) return null;
        return {
            input: Array.prototype.slice.call(spectrumData),
            output: Array.prototype.slice.call(spectrumOutputData),
            sampleRate: audioContext ? audioContext.sampleRate : 44100,
            fftSize: 1024
        };
    }

    function sendEQToWorklet() {
        if (!workletNode) return;
        workletNode.port.postMessage({
            type: 'eq',
            gains: currentGains,
            qValues: currentQValues,
            enabled: isEnabled
        });
    }

    function sendEffectsToWorklet() {
        // 简化版不发送效果器参数
    }

    function sendDynamicEQToWorklet() {
        // 简化版不发送动态EQ参数
    }

    function sendLimiterToWorklet() {
        // 简化版不发送限制器参数
    }

    async function connectAudioChain() {
        if (!audioContext || !sourceNode || !workletNode) return;

        try {
            try { sourceNode.disconnect(); } catch (e) {}
            sourceNode.connect(workletNode);
            workletNode.connect(audioContext.destination);
            console.log('[MoeKoeEQ-MAIN] Audio chain connected: source → worklet → destination');
        } catch (e) {
            console.error('[MoeKoeEQ-MAIN] connectAudioChain error:', e);
        }
    }

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

            var workletReady = await initAudioWorklet();
            if (!workletReady) {
                throw new Error('AudioWorklet initialization failed');
            }

            initAnalyser();
            await connectAudioChain();

            sendEQToWorklet();

            isInitialized = true;
            isInitializing = false;
            disconnectObserver();

            console.log('[MoeKoeEQ-MAIN] EQ initialized with AudioWorklet');

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

    function createBaseNodes() { /* 不再需要 */ }
    function createAllEQNodes() { /* 不再需要 */ }
    function initEffectsNodes() { /* 不再需要 */ }
    function initDynamicEQNodes() { /* 不再需要 */ }
    function rebuildSignalPath() { /* 不再需要 */ }
    function buildStereoSignalPath() { /* 不再需要 */ }
    function buildIndependentChannelPath() { /* 不再需要 */ }
    function buildMidSidePath() { /* 不再需要 */ }
    function buildLeftOnlyPath() { /* 不再需要 */ }
    function buildRightOnlyPath() { /* 不再需要 */ }
    function insertLinearPhaseConvolver() { /* 不再需要 */ }

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
    }

    function setEffect(effectName, value, silent) {
        currentEffects[effectName] = value;
        // 简化版不处理效果器
    }

    function toggleEffects(enabled) {
        effectsEnabled = !!enabled;
    }

    function resetEffects() {
        currentEffects = Object.assign({}, AUDIO_EFFECTS_DEFAULT);
    }

    function setDynamicEQ(config) {
        dynamicEQConfig = Object.assign({}, DYNAMIC_EQ_DEFAULT, config);
    }

    function connectDynamicEQ() { /* 不再需要 */ }
    function startDynamicEQLoop() { /* 不再需要 */ }
    function stopDynamicEQLoop() { /* 不再需要 */ }

    function toggleEQ(enabled) {
        isEnabled = !!enabled;
        sendEQToWorklet();
    }

    function applyPreset(presetName, presetData) {
        if (presetData) {
            if (presetData.gains) setEQGains(presetData.gains);
        } else if (EQ_PRESETS[presetName]) {
            var preset = EQ_PRESETS[presetName];
            if (preset.gains) setEQGains(preset.gains);
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

    function applyDitherConfig() { /* 不再需要 */ }
    function applyDCFilterConfig() { /* 不再需要 */ }
    function applyTruePeakConfig() { /* 不再需要 */ }
    function updateLoudnessCompensation(amount) { /* 不再需要 */ }
    function captureReferenceProfile() { return null; }
    function matchReferenceProfile() { return null; }
    function updateLinearPhase() { /* 不再需要 */ }
    function _doLinearPhaseUpdate() { /* 不再需要 */ }
    function generateLinearPhaseImpulse() { return null; }
    function getActiveGainsForLinearPhase() { return currentGains; }
    function performIFFT() { /* 不再需要 */ }

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
                var capturedSource = sourceNode;

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

    var _isFallbackConnect = false;

    function findAndConnectAudioElement() {
        if (isInitialized || isDestroyed) return;
        fallbackConnect();
    }

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
            version: '3.0.0'
        };
    }

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

        if (!s.dynamicEQ) dynamicEQConfig = Object.assign({}, DYNAMIC_EQ_DEFAULT);
    }

    var _storageSettingsApplied = false;
    function tryApplySettings() {
        if (_storageSettingsApplied) return;
        _storageSettingsApplied = true;
    }

    function watchAudioContextState() {
        if (!audioContext) return;
    }

    function watchAudioElementSrc() {
        if (!capturedAudioElement) return;
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

        var payload = data.data || data;

        switch (data.type) {
            case 'apply-settings':
                if (payload) applySettingsFromStorage(payload);
                break;
            case 'set-gain':
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
                if (!pluginDisabled && payload.effect && typeof payload.value === 'number') {
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
                break;
        }
    });

    // ===== 初始化 =====
    console.log('[MoeKoeEQ-MAIN] Script loaded, installing intercept...');
    installCreateMediaElementSourceIntercept();
    console.log('[MoeKoeEQ-MAIN] Intercept installed, waiting for audio element...');

    observer = new MutationObserver(function(mutations) {
        if (isInitialized || isDestroyed) return;
        for (var m = 0; m < mutations.length; m++) {
            if (mutations[m].type === 'attributes' && mutations[m].target && mutations[m].target.tagName === 'AUDIO') {
                var audioEl = mutations[m].target;
                if ((audioEl.src || audioEl.currentSrc) && !hasFailedAudioElement(audioEl)) {
                    console.log('[MoeKoeEQ-MAIN] MutationObserver: audio src changed');
                    setTimeout(function() { fallbackConnect(audioEl); }, 200);
                }
                continue;
            }
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

    observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src']
    });

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

    stateBroadcastInterval = setInterval(function() {
        if (!isDestroyed && isInitialized) {
            window.postMessage({ source: MSG_SRC.MAIN, type: 'state-response', data: getState() }, _msgTargetOrigin);
        }
    }, 3000);

    window.addEventListener('beforeunload', function() {
        saveSettings();
    });

    window.addEventListener('pagehide', function(event) {
        saveSettings();
        if (event.persisted) softCleanup();
    });

    window.addEventListener('pageshow', function(event) {
        if (event.persisted && isInitialized) {
        }
    });

    document.addEventListener('visibilitychange', function() {
        if (document.hidden && isInitialized) {
        }
    });

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

    console.log('[MoeKoeEQ-MAIN] AudioWorklet version loaded (simplified)');

})();
