#pragma once

#include "dht_fan_model.h"
#include "ml_result.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/micro/micro_error_reporter.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/schema/schema_generated.h"

// Used by the device and the host replay. Keep a single instance in static storage.
class FanInference {
public:
    bool begin()
    {
        if (!model_) return false;
        if (resolver_.AddFullyConnected() != kTfLiteOk || resolver_.AddSoftmax() != kTfLiteOk) return false;
        if (interpreter_.AllocateTensors() != kTfLiteOk) return false;
        if (interpreter_.inputs_size() != 1 || interpreter_.outputs_size() != 1) return false;
        TfLiteTensor *in = interpreter_.input(0);
        TfLiteTensor *out = interpreter_.output(0);
        if (!isInt8Vector(in, fan_model::FEATURE_COUNT) || !isInt8Vector(out, 3)) return false;
        // The standard int8 softmax has exactly 1/256 resolution and zero at -128.
        if (out->params.scale != 1.0f / 256 || out->params.zero_point != -128) return false;
        input_ = in;
        output_ = out;
        return true;
    }

    bool invoke(const float (&scaled)[fan_model::FEATURE_COUNT], MlResult &result)
    {
        if (!input_ || !output_) return false;
        for (uint8_t i = 0; i < fan_model::FEATURE_COUNT; ++i) {
            if (!std::isfinite(scaled[i]) || scaled[i] < -1 || scaled[i] > 1) return false;
            const int q = static_cast<int>(std::lround(scaled[i] / input_->params.scale)) + input_->params.zero_point;
            input_->data.int8[i] = static_cast<int8_t>(q < -128 ? -128 : (q > 127 ? 127 : q));
        }
        if (interpreter_.Invoke() != kTfLiteOk) return false;
        int best = 0;
        for (int i = 0; i < 3; ++i) {
            const int score = output_->data.int8[i];
            if (score > output_->data.int8[best]) best = i;
            result.probabilities[i] = (score - output_->params.zero_point) * output_->params.scale;
        }
        result.predicted = static_cast<FanAction>(best);
        return ml_probabilities_valid(result);
    }

    size_t arenaUsedBytes() const { return interpreter_.arena_used_bytes(); }

private:
    static const tflite::Model *verifiedModel()
    {
        // Verify offsets before the interpreter follows any FlatBuffer pointer.
        flatbuffers::Verifier verifier(fan_model_tflite, sizeof(fan_model_tflite));
        if (!tflite::VerifyModelBuffer(verifier)) return nullptr;
        const auto *model = tflite::GetModel(fan_model_tflite);
        if (model->version() != TFLITE_SCHEMA_VERSION || !model->subgraphs() || model->subgraphs()->size() != 1)
            return nullptr;
        const auto *graph = model->subgraphs()->Get(0);
        if (!graph->inputs() || !graph->outputs() || !graph->tensors()) return nullptr;
        for (const auto *tensor : *graph->tensors()) {
            if (tensor->type() != tflite::TensorType_INT8 && tensor->type() != tflite::TensorType_INT32) return nullptr;
        }
        return model;
    }

    static bool isInt8Vector(const TfLiteTensor *v, int size)
    {
        return v && v->type == kTfLiteInt8 && v->data.int8 && v->dims && v->dims->size == 2
            && v->dims->data[0] == 1 && v->dims->data[1] == size && v->bytes == static_cast<size_t>(size)
            && std::isfinite(v->params.scale) && v->params.scale > 0 && v->params.zero_point >= -128
            && v->params.zero_point <= 127;
    }

    alignas(16) uint8_t arena_[4 * 1024];
    tflite::MicroErrorReporter reporter_;
    tflite::MicroMutableOpResolver<2> resolver_;
    const tflite::Model *model_ = verifiedModel();
    tflite::MicroInterpreter interpreter_{model_, resolver_, arena_, sizeof(arena_), &reporter_};
    TfLiteTensor *input_ = nullptr;
    TfLiteTensor *output_ = nullptr;
};
