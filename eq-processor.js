/**
 * MoeKoe EQ AudioWorklet Processor
 * 替代原来的 106 个 Web Audio 节点，全部用数学运算实现
 * 
 * CPU 占用对比：
 * - 原版：106 个节点（7个 WaveShaper 4x + 3 个 Convolver + 7 个 Compressor）
 * - 新版：1 个 AudioWorkletProcessor，纯数学运算
 */

// EQ 频率表
const EQ_FREQUENCIES = [
    20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160,
    200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600,
    2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000
];

class MoeKoeEQProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        
        this._sampleRate = sampleRate;
        this._frameCount = 0;
        
        // ===== EQ 参数 =====
        this._eqEnabled = true;
        this._eqGains = new Float32Array(31); // dB
        this._eqQValues = new Float32Array(31);
        for (let i = 0; i < 31; i++) {
            this._eqGains[i] = 0;
            this._eqQValues[i] = 1.4;
        }
        
        // EQ 滤波器状态（二阶 IIR）
        this._eqFilters = new Array(31);
        for (let i = 0; i < 31; i++) {
            this._eqFilters[i] = { x1: 0, x2: 0, y1: 0, y2: 0 };
        }
        
        // ===== 效果器参数 =====
        this._effects = {
            bassBoost: 0,       // 0-100
            trebleBoost: 0,     // 0-100
            warmth: 0,          // 0-100
            clarity: 0,         // 0-100
            presence: 0,        // 0-100
            vocalEnhance: 0,    // 0-100
            dynamicBass: 0,     // 0-100
            dynamicEnhance: 0,  // 0-100
            ambiance: 0,        // 0-100
            surround: 0,        // 0-100
            reverb: 0,          // 0-100
            harmonicExciter: 0, // 0-100
            crossfeed: 0,       // 0-100
            subHarmonic: 0,     // 0-100
            tubeSaturation: 0,  // 0-100
            multibandComp: 0,   // 0-100
            deEsser: 0,         // 0-100
            stereoWidener: 0,   // 0-100
            tapeEmulation: 0,   // 0-100
            loudnessMaximizer: 0, // 0-100
            outputGain: 50,     // 0-100, 50 = 0dB
            stereoBalance: 50,  // 0-100, 50 = 中间
            loudnessCompensation: 0 // 0-100
        };
        this._effectsEnabled = true;
        
        // 效果器内部状态
        this._effectState = {
            // 延迟线（用于 ambience/surround/crossfeed/reverb）
            delayBuffer: new Float32Array(9600), // 200ms @ 48kHz
            delayIndex: 0,
            delayBuffer2: new Float32Array(9600),
            delayIndex2: 0,
            // 压缩器状态
            compEnv: 0,
            compEnv2: 0,
            // 混响状态
            reverbBuffer: new Float32Array(19200), // 400ms
            reverbIndex: 0,
            // 动态低音
            dynamicBassEnv: 0,
            // DeEsser
            deEsserEnv: 0,
            // 频谱分析
            fftBuffer: new Float32Array(2048),
            fftIndex: 0
        };
        
        // ===== 频谱分析 =====
        this._spectrumEnabled = true;
        this._spectrumData = new Uint8Array(512);
        this._spectrumCounter = 0;
        
        // ===== 动态 EQ =====
        this._dynamicEQEnabled = false;
        this._dynamicEQThreshold = -30;
        this._dynamicEQRatio = 6;
        this._dynamicEQAttack = 0.02;
        this._dynamicEQRelease = 0.15;
        this._dynamicEQGains = new Float32Array(31);
        for (let i = 0; i < 31; i++) this._dynamicEQGains[i] = 1.0;
        this._dynamicEQAnalyser = new Float32Array(1024);
        this._dynamicEQCounter = 0;
        
        // ===== 限制器 =====
        this._limiterEnabled = true;
        this._limiterThreshold = -3; // dB
        this._limiterRelease = 0.15;
        this._limiterEnv = 0;
        
        // ===== 消息端口 =====
        this.port.onmessage = (e) => this._handleMessage(e.data);
        
        // 预计算 peaking EQ 系数缓存
        this._eqCoeffs = new Array(31);
        this._eqCoeffsDirty = true;
        this._lastGains = new Float32Array(31);
        this._lastQValues = new Float32Array(31);
        
        // 采样率变化时重新计算
        this._updateEQCoeffs();
    }
    
    _handleMessage(data) {
        switch (data.type) {
            case 'eq':
                if (data.gains) {
                    for (let i = 0; i < 31; i++) {
                        this._eqGains[i] = data.gains[i] || 0;
                    }
                    this._eqCoeffsDirty = true;
                }
                if (data.qValues) {
                    for (let i = 0; i < 31; i++) {
                        this._eqQValues[i] = data.qValues[i] || 1.4;
                    }
                    this._eqCoeffsDirty = true;
                }
                if (data.enabled !== undefined) {
                    this._eqEnabled = data.enabled;
                }
                break;
                
            case 'effects':
                if (data.effects) {
                    Object.assign(this._effects, data.effects);
                }
                if (data.enabled !== undefined) {
                    this._effectsEnabled = data.enabled;
                }
                break;
                
            case 'dynamicEQ':
                if (data.enabled !== undefined) this._dynamicEQEnabled = data.enabled;
                if (data.threshold !== undefined) this._dynamicEQThreshold = data.threshold;
                if (data.ratio !== undefined) this._dynamicEQRatio = data.ratio;
                if (data.attack !== undefined) this._dynamicEQAttack = data.attack;
                if (data.release !== undefined) this._dynamicEQRelease = data.release;
                break;
                
            case 'limiter':
                if (data.enabled !== undefined) this._limiterEnabled = data.enabled;
                if (data.threshold !== undefined) this._limiterThreshold = data.threshold;
                if (data.release !== undefined) this._limiterRelease = data.release;
                break;
                
            case 'spectrum':
                this._spectrumEnabled = data.enabled !== false;
                break;
                
            case 'channelMode':
                // 预留：stereo/left/right/independent
                this._channelMode = data.mode || 'stereo';
                break;
                
            case 'midSide':
                this._midSideEnabled = data.enabled || false;
                break;
        }
    }
    
    // ===== EQ 系数计算 =====
    _updateEQCoeffs() {
        for (let i = 0; i < 31; i++) {
            const gain = this._eqGains[i];
            const q = this._eqQValues[i];
            const freq = EQ_FREQUENCIES[i];
            
            // 跳过无增益的频段
            if (Math.abs(gain) < 0.01) {
                this._eqCoeffs[i] = null;
                continue;
            }
            
            // Peaking EQ 系数
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
    
    // ===== EQ 处理 =====
    _processEQ(sample, channel) {
        if (!this._eqEnabled) return sample;
        
        if (this._eqCoeffsDirty) {
            this._updateEQCoeffs();
        }
        
        let output = sample;
        
        for (let i = 0; i < 31; i++) {
            const coeffs = this._eqCoeffs[i];
            if (!coeffs) continue;
            
            const f = this._eqFilters[i];
            const y = coeffs.b0 * output + coeffs.b1 * f.x1 + coeffs.b2 * f.x2
                     - coeffs.a1 * f.y1 - coeffs.a2 * f.y2;
            
            f.x2 = f.x1;
            f.x1 = output;
            f.y2 = f.y1;
            f.y1 = y;
            
            output = y;
        }
        
        return output;
    }
    
    // ===== 效果器处理 =====
    _processEffects(left, right) {
        if (!this._effectsEnabled) return [left, right];
        
        const e = this._effects;
        const s = this._effectState;
        
        // 1. Bass Boost (低架滤波器近似)
        if (e.bassBoost > 0) {
            const gain = (e.bassBoost / 100) * 12; // +12dB
            const factor = Math.pow(10, gain / 20);
            // 简单的低频增强：混合低频信号
            const bassL = (s.delayBuffer[(s.delayIndex - 1 + s.delayBuffer.length) % s.delayBuffer.length] + left) * 0.5;
            const bassR = (s.delayBuffer2[(s.delayIndex2 - 1 + s.delayBuffer2.length) % s.delayBuffer2.length] + right) * 0.5;
            left = left + bassL * (factor - 1) * 0.3;
            right = right + bassR * (factor - 1) * 0.3;
        }
        
        // 2. Treble Boost (高架滤波器近似)
        if (e.trebleBoost > 0) {
            const gain = (e.trebleBoost / 100) * 10;
            const factor = Math.pow(10, gain / 20);
            const highL = left - (s.delayBuffer[(s.delayIndex - 1 + s.delayBuffer.length) % s.delayBuffer.length] + left) * 0.5;
            const highR = right - (s.delayBuffer2[(s.delayIndex2 - 1 + s.delayBuffer2.length) % s.delayBuffer2.length] + right) * 0.5;
            left = left + highL * (factor - 1) * 0.3;
            right = right + highR * (factor - 1) * 0.3;
        }
        
        // 3. Warmth (中低频增强)
        if (e.warmth > 0) {
            const factor = 1 + (e.warmth / 100) * 0.3;
            const midL = (left + (s.delayBuffer[(s.delayIndex - 2 + s.delayBuffer.length) % s.delayBuffer.length] || 0)) * 0.5;
            const midR = (right + (s.delayBuffer2[(s.delayIndex2 - 2 + s.delayBuffer2.length) % s.delayBuffer2.length] || 0)) * 0.5;
            left = left * (1 - e.warmth / 300) + midL * (e.warmth / 300) * factor;
            right = right * (1 - e.warmth / 300) + midR * (e.warmth / 300) * factor;
        }
        
        // 4. Clarity (高频清晰度)
        if (e.clarity > 0) {
            const factor = 1 + (e.clarity / 100) * 0.5;
            const prevL = s.delayBuffer[(s.delayIndex - 1 + s.delayBuffer.length) % s.delayBuffer.length] || 0;
            const prevR = s.delayBuffer2[(s.delayIndex2 - 1 + s.delayBuffer2.length) % s.delayBuffer2.length] || 0;
            const highL = left - prevL * 0.9;
            const highR = right - prevR * 0.9;
            left = left + highL * (factor - 1) * 0.4;
            right = right + highR * (factor - 1) * 0.4;
        }
        
        // 5. Presence (中高频增强)
        if (e.presence > 0) {
            const factor = 1 + (e.presence / 100) * 0.4;
            const prevL = s.delayBuffer[(s.delayIndex - 1 + s.delayBuffer.length) % s.delayBuffer.length] || 0;
            const prevR = s.delayBuffer2[(s.delayIndex2 - 1 + s.delayBuffer2.length) % s.delayBuffer2.length] || 0;
            const diffL = left - prevL;
            const diffR = right - prevR;
            left = left + diffL * (factor - 1) * 0.3;
            right = right + diffR * (factor - 1) * 0.3;
        }
        
        // 6. Vocal Enhance (人声增强 - 中频)
        if (e.vocalEnhance > 0) {
            const factor = 1 + (e.vocalEnhance / 100) * 0.6;
            const mid = (left + right) * 0.5;
            const side = (left - right) * 0.5;
            left = mid * factor + side;
            right = mid * factor - side;
        }
        
        // 7. Dynamic Bass (动态低音)
        if (e.dynamicBass > 0) {
            const level = Math.max(Math.abs(left), Math.abs(right));
            const targetEnv = level > s.dynamicBassEnv ? level : s.dynamicBassEnv * 0.999;
            s.dynamicBassEnv = targetEnv;
            const boost = (1 - s.dynamicBassEnv) * (e.dynamicBass / 100) * 0.5;
            left = left * (1 + boost);
            right = right * (1 + boost);
        }
        
        // 8. Ambiance (环境声)
        if (e.ambiance > 0) {
            const delaySamples = Math.floor(this._sampleRate * 0.035); // 35ms
            const idx = (s.delayIndex - delaySamples + s.delayBuffer.length) % s.delayBuffer.length;
            const ambL = s.delayBuffer[idx] || 0;
            const ambR = s.delayBuffer2[idx] || 0;
            const mix = (e.ambiance / 100) * 0.4;
            left = left * (1 - mix) + ambR * mix;
            right = right * (1 - mix) + ambL * mix;
        }
        
        // 9. Surround (环绕声)
        if (e.surround > 0) {
            const delayL = Math.floor(this._sampleRate * 0.025);
            const delayR = Math.floor(this._sampleRate * 0.045);
            const idxL = (s.delayIndex - delayL + s.delayBuffer.length) % s.delayBuffer.length;
            const idxR = (s.delayIndex - delayR + s.delayBuffer.length) % s.delayBuffer.length;
            const surL = s.delayBuffer[idxL] || 0;
            const surR = s.delayBuffer[idxR] || 0;
            const mix = (e.surround / 100) * 0.3;
            left = left * (1 - mix) + surR * mix;
            right = right * (1 - mix) + surL * mix;
        }
        
        // 10. Harmonic Exciter (谐波激励)
        if (e.harmonicExciter > 0) {
            const amount = e.harmonicExciter / 100;
            const k = amount * 2;
            // 软削波产生谐波
            const exciteL = Math.tanh(left * (1 + k)) / Math.tanh(1 + k);
            const exciteR = Math.tanh(right * (1 + k)) / Math.tanh(1 + k);
            // 只取高频部分（差分）
            const prevL = s.delayBuffer[(s.delayIndex - 1 + s.delayBuffer.length) % s.delayBuffer.length] || 0;
            const prevR = s.delayBuffer2[(s.delayIndex2 - 1 + s.delayBuffer2.length) % s.delayBuffer2.length] || 0;
            const highL = exciteL - prevL;
            const highR = exciteR - prevR;
            left = left + highL * amount * 0.3;
            right = right + highR * amount * 0.3;
        }
        
        // 11. Sub Harmonic (次谐波)
        if (e.subHarmonic > 0) {
            const amount = e.subHarmonic / 100;
            const absL = Math.abs(left);
            const absR = Math.abs(right);
            // 产生低频谐波
            const subL = (absL > 0.1 ? Math.sign(left) * Math.sqrt(absL) : 0) * amount * 0.3;
            const subR = (absR > 0.1 ? Math.sign(right) * Math.sqrt(absR) : 0) * amount * 0.3;
            left = left + subL;
            right = right + subR;
        }
        
        // 12. Tube Saturation (电子管饱和)
        if (e.tubeSaturation > 0) {
            const k = (e.tubeSaturation / 100) * 4;
            const tanhK = Math.tanh(1 + k);
            left = (1 + k) * Math.tanh(left * (1 + k)) / tanhK;
            right = (1 + k) * Math.tanh(right * (1 + k)) / tanhK;
        }
        
        // 13. Tape Emulation (磁带模拟)
        if (e.tapeEmulation > 0) {
            const k = (e.tapeEmulation / 100) * 3;
            left = left + k * 0.15 * (Math.sin(Math.PI * left) - left);
            right = right + k * 0.15 * (Math.sin(Math.PI * right) - right);
        }
        
        // 14. Crossfeed (串音)
        if (e.crossfeed > 0) {
            const mix = (e.crossfeed / 100) * 0.35;
            const delaySamples = Math.floor(this._sampleRate * 0.00025);
            const idx = (s.delayIndex - delaySamples + s.delayBuffer.length) % s.delayBuffer.length;
            const crossL = s.delayBuffer[idx] || 0;
            const crossR = s.delayBuffer2[idx] || 0;
            left = left + crossR * mix;
            right = right + crossL * mix;
        }
        
        // 15. Stereo Widener (立体声扩展)
        if (e.stereoWidener > 0) {
            const mid = (left + right) * 0.5;
            const side = (left - right) * 0.5;
            const widen = 1 + (e.stereoWidener / 100) * 0.5;
            left = mid + side * widen;
            right = mid - side * widen;
        }
        
        // 16. De-Esser (齿音消除)
        if (e.deEsser > 0) {
            const level = Math.max(Math.abs(left), Math.abs(right));
            const targetEnv = level > s.deEsserEnv ? level : s.deEsserEnv * 0.999;
            s.deEsserEnv = targetEnv;
            if (s.deEsserEnv > 0.3) {
                const reduce = (s.deEsserEnv - 0.3) * (e.deEsser / 100) * 0.5;
                left = left * (1 - reduce);
                right = right * (1 - reduce);
            }
        }
        
        // 17. Multiband Compressor (多段压缩 - 简化版)
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
        
        // 18. Loudness Maximizer (响度最大化)
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
        
        // 19. Output Gain
        const gainDB = (e.outputGain - 50) / 50 * 12; // -12 to +12 dB
        const gainFactor = Math.pow(10, gainDB / 20);
        left *= gainFactor;
        right *= gainFactor;
        
        // 20. Stereo Balance
        if (e.stereoBalance !== 50) {
            const pan = (e.stereoBalance - 50) / 50; // -1 to 1
            if (pan < 0) {
                right *= (1 + pan);
            } else {
                left *= (1 - pan);
            }
        }
        
        // 更新延迟缓冲区
        s.delayBuffer[s.delayIndex] = left;
        s.delayIndex = (s.delayIndex + 1) % s.delayBuffer.length;
        s.delayBuffer2[s.delayIndex2] = right;
        s.delayIndex2 = (s.delayIndex2 + 1) % s.delayBuffer2.length;
        
        return [left, right];
    }
    
    // ===== 动态 EQ 处理 =====
    _processDynamicEQ(left, right) {
        if (!this._dynamicEQEnabled) return [left, right];
        
        // 每 64 样本分析一次
        this._dynamicEQCounter++;
        if (this._dynamicEQCounter < 64) {
            // 应用缓存的增益
            for (let i = 0; i < 31; i++) {
                const gain = this._dynamicEQGains[i];
                if (Math.abs(gain - 1.0) > 0.01) {
                    left *= gain;
                    right *= gain;
                }
            }
            return [left, right];
        }
        this._dynamicEQCounter = 0;
        
        // 简化的频率分析
        const level = Math.max(Math.abs(left), Math.abs(right));
        const db = level > 0 ? 20 * Math.log10(level) : -100;
        
        for (let i = 0; i < 31; i++) {
            const threshold = this._dynamicEQThreshold;
            let gain = 1.0;
            
            if (db > threshold) {
                const excess = db - threshold;
                const reduction = excess * (1 - 1 / this._dynamicEQRatio);
                gain = Math.pow(10, -reduction / 20);
            }
            
            // 平滑过渡
            const target = gain;
            const current = this._dynamicEQGains[i];
            const diff = target - current;
            if (Math.abs(diff) > 0.01) {
                this._dynamicEQGains[i] += diff * 0.1;
            }
        }
        
        // 应用增益
        for (let i = 0; i < 31; i++) {
            const gain = this._dynamicEQGains[i];
            if (Math.abs(gain - 1.0) > 0.01) {
                left *= gain;
                right *= gain;
            }
        }
        
        return [left, right];
    }
    
    // ===== 限制器处理 =====
    _processLimiter(left, right) {
        if (!this._limiterEnabled) return [left, right];
        
        const threshold = Math.pow(10, this._limiterThreshold / 20);
        const level = Math.max(Math.abs(left), Math.abs(right));
        
        if (level > threshold) {
            const targetEnv = level;
            this._limiterEnv = Math.max(targetEnv, this._limiterEnv * 0.999);
        } else {
            this._limiterEnv *= (1 - this._limiterRelease);
        }
        
        if (this._limiterEnv > threshold) {
            const gain = threshold / this._limiterEnv;
            left *= gain;
            right *= gain;
        }
        
        return [left, right];
    }
    
    // ===== 频谱分析（简化 FFT）=====
    _updateSpectrum(left, right) {
        if (!this._spectrumEnabled) return;
        
        const s = this._effectState;
        const mono = (left + right) * 0.5;
        
        // 填充 FFT 缓冲区
        s.fftBuffer[s.fftIndex] = mono;
        s.fftIndex = (s.fftIndex + 1) % s.fftBuffer.length;
        
        // 每 256 样本计算一次频谱
        this._spectrumCounter++;
        if (this._spectrumCounter < 256) return;
        this._spectrumCounter = 0;
        
        // 简化的频谱分析（使用 Goertzel 算法计算关键频率）
        for (let i = 0; i < 32; i++) {
            const freq = 20 * Math.pow(10, (i / 32) * Math.log10(1000)); // 20Hz - 1kHz
            const k = Math.round(freq * s.fftBuffer.length / this._sampleRate);
            const w = 2 * Math.PI * k / s.fftBuffer.length;
            
            let re = 0, im = 0;
            for (let n = 0; n < s.fftBuffer.length; n++) {
                const idx = (s.fftIndex + n) % s.fftBuffer.length;
                re += s.fftBuffer[idx] * Math.cos(w * n);
                im -= s.fftBuffer[idx] * Math.sin(w * n);
            }
            
            const magnitude = Math.sqrt(re * re + im * im) / s.fftBuffer.length;
            const db = 20 * Math.log10(magnitude + 0.0001);
            const normalized = Math.max(0, Math.min(1, (db + 100) / 100));
            this._spectrumData[i] = Math.floor(normalized * 255);
        }
    }
    
    // ===== 主处理函数 =====
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        
        if (!input || !input.length || !output || !output.length) return true;
        
        const numChannels = Math.min(input.length, output.length);
        const numSamples = input[0].length;
        
        // 处理每个样本
        for (let i = 0; i < numSamples; i++) {
            let left = input[0] ? input[0][i] : 0;
            let right = input[1] ? input[1][i] : left;
            
            // 1. EQ 处理
            left = this._processEQ(left, 0);
            right = this._processEQ(right, 1);
            
            // 2. 动态 EQ
            [left, right] = this._processDynamicEQ(left, right);
            
            // 3. 效果器处理
            [left, right] = this._processEffects(left, right);
            
            // 4. 限制器
            [left, right] = this._processLimiter(left, right);
            
            // 5. 频谱分析
            this._updateSpectrum(left, right);
            
            // 输出
            if (output[0]) output[0][i] = left;
            if (output[1]) output[1][i] = right;
        }
        
        // 定期发送频谱数据到主线程
        this._frameCount++;
        if (this._frameCount % 8 === 0 && this._spectrumEnabled) {
            this.port.postMessage({
                type: 'spectrum',
                data: Array.from(this._spectrumData)
            });
        }
        
        // 定期发送状态到主线程
        if (this._frameCount % 300 === 0) {
            this.port.postMessage({
                type: 'state',
                dynamicEQGains: Array.from(this._dynamicEQGains),
                limiterEnv: this._limiterEnv
            });
        }
        
        return true;
    }
}

registerProcessor('moeKoe-eq-processor', MoeKoeEQProcessor);
