import type { GameConfig } from '../types'

export const defaultConfig: GameConfig = {
  version: 1,
  ui: {
    palette: {
      bg: '#070812',
      panelRGBA: 'rgba(14,18,38,0.72)',
      neonCyan: '#22F5FF',
      neonMagenta: '#FF2BD6',
      neonLime: '#B6FF2E',
      danger: '#FF3B3B',
      text: '#EAF0FF',
    },
    tipsTR: [
      'Raslantı yok: Aynı girdiler aynı sonucu üretir.',
      'Dalga süresi sabittir; başarını Öldürme Oranı belirler.',
      'Ceza, süreyi değil ödülü/hasarı etkiler.',
      'Modüller seçerek açılır; drop-rate yoktur.',
      'Kalite düşürmek mobilde düşman sayısını sınırlar.',
      'Prestij: reset + kalıcı çarpan (deterministik).',
    ],
  },

  sim: {
    tickHz: 60,
    waveDurationSec: 30.0,
    timeScales: [1, 2, 4],
    autoOverlayCloseSec: 1.6,
  },

  progression: {
    clearFactorRho: 0.9,

    d0: 8,
    dmgGrowthD: 0.095,
    r0: 1.1,
    rMax: 8.0,
    fireRateLogK: 0.55,

    prestigeMu: 0.06,

    a: 0.042,
    b: 0.028,
    c: 0.018,
    earlyEnd: 50,
    midEnd: 200,

    nMin: 10,
    nMaxHigh: 90,
    nMaxMed: 70,
    nMaxLow: 50,
    u: 1.9,
    v: 2.2,
    spawnP: 1.6,

    enemyTypeA: 17,
    enemyTypeB: 29,
    enemyTypeC: 7,

    patternP1: 9,
    patternP2: 4,
    patternCountP: 12,
    burstPatternValues: [3, 7, 10],
    burstTightness: 0.42,

    typeVariationBeta: 0.28,
    typeVariationM: 9,
    armorMax: 0.75,
    armorAlpha: 0.12,
    speedK: 0.9,

    th0: 0.7,
    thSlope: 0.07,
    thMin: 0.7,
    thMax: 0.92,

    penK: 0.9,
    penMin: 0.4,

    g0: 0.55,
    gamma: 0.72,
    goldWaveK: 0.18,
    p0: 1,
    pointsGrowthPer10: 1.28,

    enableEscapeDamage: true,
    escapeDamage: 2.0,
    deficitBoost: 1.6,

    offlineFactor: 0.6,
    rewardedOfflineFactor: 1.2,
    offlineKillK0: 0.22,
    offlineKillK1: 0.75,
  },

  tower: {
    baseRange: 160,
    rangeGrowth: 4.0,
    baseHP0: 100,
    baseHPGrowth: 0.08,
    armorPierce0: 0.0,
  },

  economy: {
    upgradeCostBase: 10,
    upgradeCostGrowth: 1.13,
    moduleUnlockPointCostBase: 2,
    moduleUnlockPointCostGrowth: 1.22,
    moduleUpgradeGoldBase: 25,
    moduleUpgradeGoldGrowth: 1.16,
  },

  enemies: {
    types: [
      { id: 'V1', nameTR: 'Vektör', color: '#22F5FF', hpMult: 1.0, armorMult: 1.0, baseSpeed: 58 },
      { id: 'PR', nameTR: 'Prizma', color: '#FF2BD6', hpMult: 1.25, armorMult: 1.1, baseSpeed: 52 },
      { id: 'IO', nameTR: 'İyon', color: '#B6FF2E', hpMult: 0.85, armorMult: 0.9, baseSpeed: 68 },
      { id: 'NX', nameTR: 'Nexus', color: '#EAF0FF', hpMult: 1.6, armorMult: 1.25, baseSpeed: 46 },
      { id: 'CR', nameTR: 'Krom', color: '#7A7CFF', hpMult: 1.05, armorMult: 1.55, baseSpeed: 50 },
      { id: 'PH', nameTR: 'Faz', color: '#FFB000', hpMult: 0.95, armorMult: 0.85, baseSpeed: 74 },
    ],
  },

  modules: {
    slotCount: 6,
    defs: [
      { id: 'MX_FLUX', nameTR: 'Akı Çarpanı', category: 'OFFENSE', iconConcept: 'çift halka + oklar', dmgMultPerLevel: 0.06 },
      { id: 'MX_SPARK', nameTR: 'Kıvılcım İletkeni', category: 'OFFENSE', iconConcept: 'neon şimşek izleri', dmgFlatPerLevel: 2.4 },
      { id: 'MX_PRISM', nameTR: 'Prizma Odak', category: 'OFFENSE', iconConcept: 'üçgen prizma + ışın', dmgMultPerLevel: 0.04, fireRateBonusPerLevel: 0.04 },
      { id: 'MX_OVERCLK', nameTR: 'Aşırı Saat', category: 'OFFENSE', iconConcept: 'saat kadranı + hız çizgisi', fireRateBonusPerLevel: 0.08 },
      { id: 'MX_LENS', nameTR: 'Mercek Dizisi', category: 'OFFENSE', iconConcept: 'altıgen lens petek', rangeBonusPerLevel: 6.0 },
      { id: 'MX_PIERCE', nameTR: 'Zırh Yarıcı', category: 'OFFENSE', iconConcept: 'delici ok ucu', armorPiercePerLevel: 0.04 },

      { id: 'DF_BULWARK', nameTR: 'Siper Protokolü', category: 'DEFENSE', iconConcept: 'kalkan + grid', baseHPBonusPerLevel: 8.0 },
      { id: 'DF_REGEN', nameTR: 'Tamir Nanolifi', category: 'DEFENSE', iconConcept: 'dikiş izi + dalga', baseHPBonusPerLevel: 5.0 },
      { id: 'DF_SHELL', nameTR: 'Cam Zırh', category: 'DEFENSE', iconConcept: 'cam kubbe', baseHPBonusPerLevel: 10.0 },

      { id: 'UT_MINT', nameTR: 'Mikro Darphane', category: 'UTILITY', iconConcept: 'mikroçip + madeni', goldMultPerLevel: 0.03 },
      { id: 'UT_LOG', nameTR: 'Telemetri Kaydı', category: 'UTILITY', iconConcept: 'grafik çizgisi', goldMultPerLevel: 0.02 },
      { id: 'UT_CALIB', nameTR: 'Kalibrasyon Ringi', category: 'UTILITY', iconConcept: 'halkalar + işaret', dmgMultPerLevel: 0.02, goldMultPerLevel: 0.01 },

      { id: 'MX_GAUSS', nameTR: 'Gauss Kızağı', category: 'OFFENSE', iconConcept: 'ray + parçacık', dmgMultPerLevel: 0.05 },
      { id: 'MX_NODE', nameTR: 'Nöral Düğüm', category: 'UTILITY', iconConcept: 'bağlantılı noktalar', fireRateBonusPerLevel: 0.03, goldMultPerLevel: 0.015 },
      { id: 'DF_COOLANT', nameTR: 'Soğutma Hattı', category: 'DEFENSE', iconConcept: 'boru + kar tanesi', baseHPBonusPerLevel: 6.0 },

      { id: 'MX_VECTOR', nameTR: 'Vektör Eğrisi', category: 'OFFENSE', iconConcept: 'eğri ok', dmgFlatPerLevel: 1.7, fireRateBonusPerLevel: 0.03 },
      { id: 'MX_QUANTA', nameTR: 'Kuantum İz', category: 'OFFENSE', iconConcept: 'iki iz + faz kayması', dmgMultPerLevel: 0.03, armorPiercePerLevel: 0.02 },
      { id: 'UT_ROUTER', nameTR: 'Sinyal Yönlendirici', category: 'UTILITY', iconConcept: 'yön okları', rangeBonusPerLevel: 3.0, goldMultPerLevel: 0.015 },

      // The remaining defs are data-only for the UI/Codex; effects can be added later without RNG.
      { id: 'MX_ARC', nameTR: 'Ark Dizini', category: 'OFFENSE', iconConcept: 'ark çizgisi', dmgMultPerLevel: 0.02 },
      { id: 'MX_CHORD', nameTR: 'Akor Rezonansı', category: 'OFFENSE', iconConcept: 'dalga formu', dmgFlatPerLevel: 1.2 },
      { id: 'MX_SPECTR', nameTR: 'Spektrum Ayarı', category: 'OFFENSE', iconConcept: 'renk bantları', fireRateBonusPerLevel: 0.02 },
      { id: 'DF_ANCHOR', nameTR: 'Çapa Alanı', category: 'DEFENSE', iconConcept: 'çapa simgesi', baseHPBonusPerLevel: 4.0 },
      { id: 'DF_LOCK', nameTR: 'Kilitleme Hücresi', category: 'DEFENSE', iconConcept: 'kilit', baseHPBonusPerLevel: 3.5 },
      { id: 'UT_INDEX', nameTR: 'İndeksleyici', category: 'UTILITY', iconConcept: 'etiket', goldMultPerLevel: 0.01 },

      { id: 'MX_DELTA', nameTR: 'Delta İtki', category: 'OFFENSE', iconConcept: 'Δ işareti', dmgMultPerLevel: 0.02 },
      { id: 'MX_FOCUS', nameTR: 'Odak Noktası', category: 'OFFENSE', iconConcept: 'nişangâh', dmgFlatPerLevel: 1.0 },
      { id: 'UT_BUFFER', nameTR: 'Arabellek', category: 'UTILITY', iconConcept: 'kutu yığını', goldMultPerLevel: 0.012 },
      { id: 'DF_GRID', nameTR: 'Kalkan Izgarası', category: 'DEFENSE', iconConcept: 'ızgara', baseHPBonusPerLevel: 4.5 },

      { id: 'MX_TACH', nameTR: 'Takiyon Darbe', category: 'OFFENSE', iconConcept: 'hız oku', fireRateBonusPerLevel: 0.02 },
      { id: 'MX_GLYPH', nameTR: 'Glif Kesiti', category: 'OFFENSE', iconConcept: 'rün benzeri işaret', dmgMultPerLevel: 0.015 },
      { id: 'UT_LEDGER', nameTR: 'Siber Defter', category: 'UTILITY', iconConcept: 'defter', goldMultPerLevel: 0.01 },
      { id: 'DF_VAULT', nameTR: 'Kaset Kasa', category: 'DEFENSE', iconConcept: 'kasa', baseHPBonusPerLevel: 5.0 },

      { id: 'MX_PHASE', nameTR: 'Faz Sıyırma', category: 'OFFENSE', iconConcept: 'faz halkası', armorPiercePerLevel: 0.015 },
      { id: 'UT_CLOCK', nameTR: 'Zaman Damgası', category: 'UTILITY', iconConcept: 'saat', goldMultPerLevel: 0.012 },
      { id: 'DF_CORE', nameTR: 'Çekirdek Güvencesi', category: 'DEFENSE', iconConcept: 'çekirdek', baseHPBonusPerLevel: 6.5 },

      { id: 'MX_HEX', nameTR: 'Altıgen Kafes', category: 'OFFENSE', iconConcept: 'hex kafes', dmgMultPerLevel: 0.012 },
      { id: 'UT_MAP', nameTR: 'Patika Haritası', category: 'UTILITY', iconConcept: 'harita', rangeBonusPerLevel: 2.0 },
      { id: 'MX_BEAM', nameTR: 'Işın Daraltıcı', category: 'OFFENSE', iconConcept: 'ince ışın', dmgFlatPerLevel: 0.8 },

      { id: 'DF_SEAL', nameTR: 'Sızdırmazlık', category: 'DEFENSE', iconConcept: 'mühür', baseHPBonusPerLevel: 3.0 },
      { id: 'UT_LINK', nameTR: 'Bağlantı Protokolü', category: 'UTILITY', iconConcept: 'zincir', goldMultPerLevel: 0.01 },
      { id: 'MX_ORBIT', nameTR: 'Yörünge Çentiği', category: 'OFFENSE', iconConcept: 'yörünge', fireRateBonusPerLevel: 0.015 },

      { id: 'MX_RAIL', nameTR: 'Ray İmzası', category: 'OFFENSE', iconConcept: 'paralel çizgiler', dmgMultPerLevel: 0.015 },
      { id: 'DF_FUSE', nameTR: 'Sigorta Bankası', category: 'DEFENSE', iconConcept: 'sigorta', baseHPBonusPerLevel: 2.5 },
      { id: 'UT_ARCHIVE', nameTR: 'Arşiv Modu', category: 'UTILITY', iconConcept: 'arşiv kutusu', goldMultPerLevel: 0.008 },

      { id: 'MX_PULSE', nameTR: 'Darbe Dizisi', category: 'OFFENSE', iconConcept: 'nabız', dmgFlatPerLevel: 0.9 },
      { id: 'DF_SPINE', nameTR: 'Omurga Çerçeve', category: 'DEFENSE', iconConcept: 'omurga', baseHPBonusPerLevel: 3.5 },
      { id: 'UT_AUDIT', nameTR: 'Denetim Kaydı', category: 'UTILITY', iconConcept: 'check', goldMultPerLevel: 0.01 },
    ],
  },
}
