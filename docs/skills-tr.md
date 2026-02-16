# NEON GRID — Skills Sistemi (TR)

Tarih: 16 Şubat 2026

Bu doküman oyundaki Skills (Yetenekler) sisteminin tasarımını ve kurallarını tanımlar.

## 1) Amaçlar (Non‑Negotiable)

- RNG yok: Skills tetiklemeleri ve sonuçları deterministiktir.
- Etkiler hissedilir olmalı ama oyunu bozmamalı.
- Progression net olmalı: Wave sonu XP → Level → Skill Point.
- Ağaç okunabilir olmalı: 3 branch ve tier kilitleri.

## 2) Temel Akış

- Wave bittiğinde XP verilir.
- XP, seviye atlama eşiğini geçerse seviye artar.
- Her seviye atladığında Skill Point kazanılır.

### XP formülü

- Wave XP, taban bir değerin wave’e göre artan bir çarpanla hesaplanması mantığıyla ilerler.
- XP kazancı, Utility tarafındaki XP pasifleriyle çarpılabilir.

Not: Tüm XP hesapları deterministiktir (aynı state + aynı wave → aynı XP).

## 3) Skill Tree Yapısı

### Branch’ler

- **Attack**: DPS odaklı; damage / fire rate / crit / armor pierce / multi‑shot / range karma etkiler.
- **Defense**: dayanıklılık odaklı; HP / escape damage taken / repair verimi.
- **Utility**: ekonomi ve tempo; gold/Paladyum ödülleri / shop indirimleri / XP / cooldown / range.

### Tier sistemi (1..4)

- Tier 1: başlangıç
- Tier 2 açmak için: aynı branch içinde **en az 2 skill** (rank>0)
- Tier 3 açmak için: aynı branch içinde **en az 4 skill**
- Tier 4 açmak için: aynı branch içinde **en az 6 skill**

### Tier‑1 Cap (Branch başına)

- Tier‑1’de, **branch başına en fazla 6 farklı skill** unlock edilebilir.
- Bu cap:
  - Yeni Tier‑1 skill *unlock* etmeyi engeller.
  - Daha önce unlock edilmiş Tier‑1 skill’lere *rank up* yapmayı engellemez.
  - Tier 2/3/4 skill unlock’larını engellemez.

Amaç: Erken oyunda “Tier‑1’e yığılma”yı sınırlandırıp oyuncuyu tier ilerlemesine teşvik etmek.

## 4) Skill Satın Alma Kuralları

- Her unlock veya rank up: **1 Skill Point**.
- Bir skill’in `maxRank` değeri vardır (1/2/3).
- Bazı skill’ler prerequisites ister (örn. belirli bir skill’in belirli rank’ı).

UI tarafında:
- Tier kilitleri ve prerequisites sağlanmıyorsa satın alma butonu disabled olur.
- Tier‑1 cap doluysa Tier‑1 unlock butonu disabled olur ve sebep gösterilir.

## 5) Etkiler ve Birikim (Aggregation)

- Skill etkileri `effects` alanı ile tanımlanır.
- Bir skill’in etkisi, **rank ile lineer** ölçeklenir: `toplamEtki += (perRankEtki * rank)`.
- Sonuçlar deterministik simülasyonda tek bir “pasif paket” olarak kullanılır.

### Clamps (denge)

Toplam etkiler bazı alanlarda clamp edilir (örn. aşırı büyümeyi engellemek için). Bu, “etkiler büyük olsun ama oyunu bozmasın” hedefi için güvenlik ağını sağlar.

## 6) Respec (Paladyum)

- Respec: tüm skill node’larını sıfırlar, SP’yi iade eder.
- Maliyet Paladyum ile ödenir ve her respec’te artar.
- UI, respec butonunda mevcut maliyeti gösterir ve onay ister.

## 7) Save/Load

- Skills state save dosyasının bir parçasıdır:
  - level, xp, skillPoints
  - nodes (id → rank)
  - respecCount
  - cooldowns (skill kaynaklı wave cooldown’ları)

## 8) İçerik Boyutu

- Toplam: **117 skill**
  - Attack: 39
  - Defense: 40
  - Utility: 38

Not: İçerik data‑driven’dır; UI otomatik listeler.
