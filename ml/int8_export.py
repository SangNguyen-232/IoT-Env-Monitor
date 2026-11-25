"""Inspect and qualify quantized models during training export."""
import numpy as np
from trend_features import (LABELS, WINDOW_SIZE, FEATURE_NAMES, FEATURE_SCALES,
                            extract_window_features, scale_features, band_label)


def invoke_int8_tflite(tf, content: bytes, scaled_samples: np.ndarray) -> tuple[np.ndarray, dict]:
    from tensorflow.lite.python import schema_py_generated as schema

    flat = schema.Model.GetRootAsModel(content, 0)
    if flat.Version() != 3 or flat.SubgraphsLength() != 1:
        raise ValueError("Unsupported TFLite schema/subgraphs")
    allowed = {
        schema.BuiltinOperator.FULLY_CONNECTED: "FULLY_CONNECTED",
        schema.BuiltinOperator.SOFTMAX: "SOFTMAX",
    }
    graph = flat.Subgraphs(0)
    for i in range(graph.TensorsLength()):
        tensor = graph.Tensors(i)
        if tensor.Type() not in (schema.TensorType.INT8, schema.TensorType.INT32):
            raise ValueError("Export contains non-integer tensors")
        if tensor.Quantization() is None or tensor.Quantization().ScaleLength() != 1:
            raise ValueError("Vendored TFLM kernels require per-tensor quantization")
    operators = []
    for index in range(flat.OperatorCodesLength()):
        op = flat.OperatorCodes(index)
        code = op.DeprecatedBuiltinCode() if op.BuiltinCode() == 0 else op.BuiltinCode()
        if code not in allowed:
            raise ValueError(f"Unsupported ESP32 operator code {code}")
        operators.append({"name": allowed[code], "version": int(op.Version())})

    interpreter = tf.lite.Interpreter(model_content=content, num_threads=1,
                                      experimental_op_resolver_type=tf.lite.experimental.OpResolverType.BUILTIN_REF)
    interpreter.allocate_tensors()
    inputs, outputs = interpreter.get_input_details(), interpreter.get_output_details()
    if len(inputs) != 1 or len(outputs) != 1:
        raise ValueError("Model requires exactly one input and one output tensor")
    inp, out = inputs[0], outputs[0]
    if tuple(inp["shape"]) != (1, len(FEATURE_NAMES)) or tuple(out["shape"]) != (1, 3):
        raise ValueError(f"Model requires shape (1,{len(FEATURE_NAMES)}) -> (1,3)")
    if inp["dtype"] != np.int8 or out["dtype"] != np.int8:
        raise ValueError("Model requires full-integer int8 input and int8 output tensors")

    in_scale, in_zp = float(inp["quantization"][0]), int(inp["quantization"][1])
    out_scale, out_zp = float(out["quantization"][0]), int(out["quantization"][1])
    if in_scale <= 0 or out_scale <= 0:
        raise ValueError("Invalid int8 quantization scale")

    probs = np.empty((len(scaled_samples), 3), dtype=np.float32)
    for idx, sample in enumerate(scaled_samples):
        units = sample / in_scale
        rounded = np.copysign(np.floor(np.abs(units) + 0.5), units)  # std::lround in firmware
        q_in = np.clip(rounded + in_zp, -128, 127).astype(np.int8)
        interpreter.set_tensor(inp["index"], q_in.reshape(1, -1))
        interpreter.invoke()
        q_out = interpreter.get_tensor(out["index"])[0].astype(np.int32)
        deq = np.maximum(0.0, (q_out - out_zp) * out_scale).astype(np.float32)
        total = float(np.sum(deq))
        if not np.isfinite(total) or total <= 0.90 or total >= 1.10:
            raise ValueError(f"Invalid dequantized softmax sum: {total}")
        probs[idx] = deq

    return probs, {
        "quantization": "full_int8_io",
        "operators": operators,
        "input": {
            "shape": [1, len(FEATURE_NAMES)],
            "dtype": "int8",
            "scale": in_scale,
            "zero_point": in_zp,
            "features": list(FEATURE_NAMES),
            "pre_divisors": FEATURE_SCALES.tolist(),
        },
        "output": {
            "shape": [1, 3],
            "dtype": "int8",
            "scale": out_scale,
            "zero_point": out_zp,
            "labels": list(LABELS),
        },
    }


def evaluate_scenarios(tf, content):
    # Same final reading, reference hysteresis initially OFF, opposite trends.
    windows = {
        "rising": ([27.3, 27.5, 27.7, 27.9, 28.1, 28.3, 28.5], [63.8, 65, 66.2, 67.4, 68.6, 69.8, 71], "ON"),
        "falling": ([29.7, 29.5, 29.3, 29.1, 28.9, 28.7, 28.5], [74.6, 74, 73.4, 72.8, 72.2, 71.6, 71], "OFF"),
        "steady": ([28.5] * WINDOW_SIZE, [71] * WINDOW_SIZE, "HOLD"),
    }
    raw = [extract_window_features(t, h, np.arange(WINDOW_SIZE) * 5, False) for t, h, _ in windows.values()]
    scores, _ = invoke_int8_tflite(tf, content, scale_features(np.asarray(raw)))
    report = {}
    for (name, (temps, humidities, expected)), probabilities in zip(windows.items(), scores):
        proposal = LABELS[int(np.argmax(probabilities))]
        if proposal != expected or probabilities.max() < .8:
            raise ValueError(f"Replay {name}: expected confident {expected}; measured {proposal} {probabilities}")
        report[name] = {
            "temperature_c": temps, "humidity_percent": humidities, "fan_on_at_sample": False,
            "period_seconds": 5, "static_rule": LABELS[int(band_label(temps[-1], humidities[-1]))],
            "proposal": proposal, "scores_off_hold_on": list(map(float, probabilities)),
        }

    # Sweep a reproducible line of ambiguous stationary windows. Select a real output
    # close to a tie. The trace can be replayed exactly on host or monitored on a board.
    rh_values = np.round(np.arange(73.8, 76.21, .05), 2)
    ambiguous = np.stack([extract_window_features([27.] * WINDOW_SIZE, [h] * WINDOW_SIZE,
                                                  np.arange(WINDOW_SIZE) * 5, False) for h in rh_values])
    probs, _ = invoke_int8_tflite(tf, content, scale_features(ambiguous))
    best = np.argmin(probs.max(axis=1))
    if probs[best].max() >= .8:
        raise ValueError("No below-gate output on the stationary boundary sweep")
    report["low_score"] = {
        "temperature_c": [27.] * WINDOW_SIZE, "humidity_percent": [float(rh_values[best])] * WINDOW_SIZE,
        "fan_on_at_sample": False, "period_seconds": 5,
        "static_rule": LABELS[int(band_label(27., rh_values[best]))],
        "proposal": LABELS[int(np.argmax(probs[best]))], "scores_off_hold_on": list(map(float, probs[best])),
    }
    return report
