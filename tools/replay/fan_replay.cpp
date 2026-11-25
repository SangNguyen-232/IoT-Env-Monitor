// Host replay of the same model bytes, kernels, window and relay policy as the ESP32.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include "fan_policy.h"
#include "fan_predictor.h"

namespace {

const FanConfig profile{true, 30, 28, 75, 70, false};
const FanConfig custom{true, 35, 32, 85, 80, false};
struct Reading { float t; float rh; };
using Trace = std::array<Reading, 7>;

// Every point is below the ON thresholds. Both traces end at the same T/RH.
const Trace rising{{{27.3f,63.8f}, {27.5f,65}, {27.7f,66.2f}, {27.9f,67.4f},
                    {28.1f,68.6f}, {28.3f,69.8f}, {28.5f,71}}};
const Trace falling{{{29.7f,74.6f}, {29.5f,74}, {29.3f,73.4f}, {29.1f,72.8f},
                     {28.9f,72.2f}, {28.7f,71.6f}, {28.5f,71}}};

void check(bool pass, const char *expectation)
{
    if (pass) return;
    std::fprintf(stderr, "FAIL  %s\n", expectation);
    std::exit(1);
}

struct Bench {
    FanConfig config;
    FanPolicyInput input;
    FanPolicyState state;
    FanPredictor predictor;
    FanPolicyResult decision{false, false, "startup"};

    explicit Bench(FanMode mode = FanMode::Ai, FanConfig cfg = profile) : config(cfg) {
        check(predictor.begin(), "TFLite Micro AllocateTensors");
        input.controlAvailable = true;
        input.mode = mode;
    }

    void decide() { decision = fan_policy_step(state, input, config); }

    void sample(Reading value, uint32_t deltaMs = 5000, bool valid = true) {
        input.now += deltaMs;
        ++input.sampleSeq;
        input.dhtSampledAtMs = input.now;
        input.dhtValid = valid;
        input.temperature = value.t;
        input.humidity = value.rh;
        input.ml = predictor.evaluate(value.t, value.rh, valid, decision.on,
                                      input.dhtSampledAtMs, input.sampleSeq, input.now);
        decide();
    }

    void play(const Trace &trace) { for (Reading r : trace) sample(r); }

    void expect(bool on, const char *reason) const {
        if (decision.on != on || std::strcmp(decision.reason, reason) != 0) {
            std::fprintf(stderr, "t=%ums expected %s/%s, got %s/%s\n",
                input.now, on ? "ON" : "OFF", reason, decision.on ? "ON" : "OFF", decision.reason);
            std::exit(1);
        }
    }

    void report(const char *scenario) const {
        const MlResult &ml = input.ml;
        const char *action = fan_action_name(ml.predicted);
        if (ml.status != AiStatus::Ready) {
            std::printf("%-20s %5ums  status=%s  %s %s\n", scenario, input.now, ai_status_name(ml.status),
                        decision.on ? "ON" : "OFF", decision.reason);
            return;
        }
        std::printf("%-20s %5ums %4.1f C %5.1f %%RH  dRH=%+6.1f/min  %-11s p=[%.3f %.3f %.3f]  %s %s\n",
            scenario, input.now, input.temperature, input.humidity, ml.humiSlopePctPerMin,
            action ? action : ai_status_name(ml.status), ml.probabilities[0], ml.probabilities[1],
            ml.probabilities[2], decision.on ? "ON " : "OFF", decision.reason);
    }
};

void compareTrends()
{
    Bench ai, cool, automatic(FanMode::Auto);
    std::printf("%s  ring=%zu B  host TFLM arena used=%zu B\n", fan_model::MODEL_VERSION,
                sizeof(TemporalWindow), ai.predictor.arenaUsedBytes());
    ai.play(rising);
    cool.play(falling);
    automatic.play(rising);
    ai.report("rising / AI");
    cool.report("falling / AI");
    automatic.report("rising / AUTO");
    ai.expect(true, "ai_proactive_on");
    cool.expect(false, "ai_off");
    check(cool.input.ml.predicted == FanAction::Off
          && cool.input.ml.probabilities[0] >= FAN_AI_MIN_SCORE, "confident descending forecast");
    automatic.expect(false, "rule_off");
    check(std::fabs(ai.input.ml.humiSlopePctPerMin - 14.4f) < 0.01f, "actual timestamps and RH rate");

    // Continue the same imposed stimulus on both controllers to measure lead time.
    const uint32_t earlyOnAt = ai.input.now;
    const Reading continuation[] = {{28.7f,72.2f}, {28.9f,73.4f}, {29.1f,74.6f}, {29.3f,75.8f}};
    for (Reading r : continuation) {
        ai.sample(r);
        automatic.sample(r);
        check(ai.decision.on, "early ventilation remains active through the band");
        check(automatic.decision.on == (r.rh >= profile.humidityOn), "AUTO switches at the crossing");
    }
    automatic.report("AUTO crossing");
    std::printf("Lead on this imposed trajectory: %u s\n", (automatic.input.now - earlyOnAt) / 1000);

    Bench humidityOnly;
    for (Reading r : rising) humidityOnly.sample({28.5f, r.rh});
    humidityOnly.report("RH rise / fixed T");
    humidityOnly.expect(true, "ai_proactive_on");
}

void configurationAndShadow()
{
    Bench unconfigured(FanMode::Auto, {});
    unconfigured.play(rising);
    unconfigured.expect(false, "config_required");

    Bench shadow(FanMode::Shadow, custom);
    for (int i = 0; i < 7; ++i) shadow.sample({28.5f, 77});
    shadow.report("SHADOW / custom");
    shadow.expect(false, "rule_off");
    check(shadow.input.ml.predicted == FanAction::On, "fixed profile proposal while SHADOW uses saved rules");
    shadow.input.mode = FanMode::Ai;
    shadow.decide();
    shadow.decide();
    shadow.report("AI / custom");
    shadow.expect(false, "ai_fallback_profile_mismatch");

    // A mode change coincident with an invalid sample still starts the 10 s OFF dwell.
    shadow.input.mode = FanMode::Auto;
    shadow.sample({-1, -1}, 5000, false);
    shadow.expect(false, "sensor_invalid");
    shadow.sample({36, 86});
    shadow.expect(false, "min_off_time");
    shadow.sample({36, 86});
    shadow.expect(true, "rule_on");
}

void dwellAndFaults()
{
    Bench ai;
    ai.play(rising);
    ai.input.now += 3000; // Cup removed between nominal acquisitions.
    ai.decide();
    check(ai.decision.on, "fan remains active three seconds after startup");
    ai.sample({27, 66}, 2000);
    ai.report("cool at +5s");
    ai.expect(true, "min_on_time");
    ai.input.now += 4999;
    ai.decide();
    ai.expect(true, "min_on_time");
    ++ai.input.now;
    ai.decide();
    ai.report("cool at +10s");
    check(!ai.decision.on, "release exactly at 10 seconds for fresh low sample");

    Bench invalid;
    invalid.play(rising);
    invalid.sample({-1,-1}, 5000, false);
    invalid.report("sensor unplug");
    invalid.expect(false, "sensor_invalid");
    check(ml_effective_status(invalid.input.ml, invalid.input.sampleSeq, false,
                              invalid.input.dhtSampledAtMs, invalid.input.now) == AiStatus::SensorInvalid,
          "invalid DHT reported as sensor_invalid");
    invalid.sample({28.5f,71});
    invalid.expect(false, "ai_fallback_warming_up");

    Bench faults;
    faults.play(falling);
    faults.input.ml.sampleSeq--;
    faults.decide();
    faults.expect(false, "ai_fallback_stale");
    faults.input.ml.sampleSeq++;
    faults.input.ml.status = AiStatus::ModelError;
    faults.decide();
    faults.expect(false, "ai_fallback_model_error");
    faults.input.ml.status = AiStatus::Ready;
    faults.input.ml.probabilities[0] = NAN;
    faults.decide();
    faults.expect(false, "ai_fallback_inference_error");
    faults.sample({51, 60});
    faults.expect(true, "ai_fallback_out_of_domain");
    faults.input.now += 15001;
    faults.decide();
    faults.expect(false, "sensor_invalid");
}

void lowScore()
{
    Bench ai;
    for (int i = 0; i < 7; ++i) ai.sample({27, 74.8f});
    ai.report("low score");
    const float *p = ai.input.ml.probabilities;
    check(ai.input.ml.status == AiStatus::Ready && *std::max_element(p, p + 3) < FAN_AI_MIN_SCORE,
          "actual model produces a below-gate score");
    ai.expect(false, "ai_fallback_low_score");
}

// Deliberately inject contradictory proposals to exercise the supervisor's authority.
void supervisorLimits()
{
    Bench ai;
    ai.play(rising);
    auto forceProposal = [&](FanAction action, Reading r) {
        ai.input.now += 10000;
        ai.input.dhtSampledAtMs = ai.input.now;
        ai.input.ml.sampledAtMs = ai.input.now;
        ai.input.temperature = r.t;
        ai.input.humidity = r.rh;
        std::fill_n(ai.input.ml.probabilities, 3, 0.0f);
        ai.input.ml.probabilities[static_cast<int>(action)] = 255.0f / 256;
        ai.input.ml.predicted = action;
        ai.decide();
    };
    forceProposal(FanAction::Off, {29, 73});
    ai.expect(true, "ai_guard_hysteresis");
    forceProposal(FanAction::On, {28, 70});
    ai.expect(false, "ai_guard_threshold_off");
    forceProposal(FanAction::Off, {30, 72});
    ai.expect(true, "ai_guard_threshold_on");
}

void wrapAndGaps()
{
    TemporalWindow window;
    uint32_t seq = UINT32_MAX - 3;
    uint32_t now = UINT32_MAX - 14999;
    for (Reading r : rising) {
        window.push(r.t, r.rh, now, seq);
        if (++seq == 0) ++seq;
        now += 5000;
    }
    TemporalMetrics m;
    check(window.extract(false, m) && std::fabs(m.humiSlopePctPerMin - 14.4f) < 0.01f,
          "millis and non-zero sequence rollover");
    window.push(28.5f, 71, now, seq + 1);
    check(window.size() == 1 && !window.extract(false, m), "lost sequence restarts warm-up");
    window.push(28.5f, 71, now + 16000, seq + 2);
    check(window.size() == 1, "sampling gap restarts warm-up");
}
// Batch interface for evaluating the saved test split with the embedded kernels.
void scoreWindows()
{
    FanInference model;
    check(model.begin(), "model initialization");
    std::cout << fan_model::MODEL_VERSION << '\n';
    while (std::cin >> std::ws && !std::cin.eof()) {
        float features[fan_model::FEATURE_COUNT];
        for (float &f : features) check(bool(std::cin >> f), "expected eight scaled features per window");
        MlResult result;
        check(model.invoke(features, result), "invalid window or inference error");
        for (float p : result.probabilities) std::cout << static_cast<int>(p * 256) << ' ';
        std::cout << '\n';
    }
}
} // namespace

int main(int argc, char **argv)
{
    if (argc == 2 && std::strcmp(argv[1], "--score-windows") == 0) {
        scoreWindows();
        return 0;
    }
    check(argc == 1, "usage: fan_replay [--score-windows]");
    compareTrends();
    configurationAndShadow();
    lowScore();
    dwellAndFaults();
    supervisorLimits();
    wrapAndGaps();
    std::puts("PASS");
}
