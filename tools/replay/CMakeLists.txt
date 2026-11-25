cmake_minimum_required(VERSION 3.16)
project(fan_replay LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(FIRMWARE "${CMAKE_CURRENT_SOURCE_DIR}/../../firmware")
set(RUNTIME "${FIRMWARE}/lib/TensorFlowLite_ESP32/src")
set(LITE "${RUNTIME}/tensorflow/lite")
set(MICRO "${LITE}/micro")

# Compile the microcontroller's vendored interpreter and the two registered kernels.
add_library(tflm STATIC
    ${LITE}/c/common.cpp
    ${LITE}/core/api/error_reporter.cpp
    ${LITE}/core/api/flatbuffer_conversions.cpp
    ${LITE}/core/api/op_resolver.cpp
    ${LITE}/core/api/tensor_utils.cpp
    ${LITE}/schema/schema_utils.cpp
    ${LITE}/kernels/kernel_util.cpp
    ${LITE}/kernels/internal/quantization_util.cpp
    ${LITE}/kernels/internal/reference/portable_tensor_utils.cpp
    ${MICRO}/arena_allocator/non_persistent_arena_buffer_allocator.cpp
    ${MICRO}/arena_allocator/simple_memory_allocator.cpp
    ${MICRO}/memory_planner/greedy_memory_planner.cpp
    ${MICRO}/memory_planner/non_persistent_buffer_planner_shim.cpp
    ${MICRO}/debug_log.cpp
    ${MICRO}/flatbuffer_utils.cpp
    ${MICRO}/memory_helpers.cpp
    ${MICRO}/micro_allocation_info.cpp
    ${MICRO}/micro_allocator.cpp
    ${MICRO}/micro_context.cpp
    ${MICRO}/micro_error_reporter.cpp
    ${MICRO}/micro_graph.cpp
    ${MICRO}/micro_interpreter.cpp
    ${MICRO}/micro_resource_variable.cpp
    ${MICRO}/micro_string.cpp
    ${MICRO}/micro_utils.cpp
    ${MICRO}/kernels/kernel_util.cpp
    ${MICRO}/kernels/fully_connected.cpp
    ${MICRO}/kernels/fully_connected_common.cpp
    ${MICRO}/kernels/softmax.cpp
    ${MICRO}/kernels/softmax_common.cpp)
target_include_directories(tflm SYSTEM PUBLIC "${RUNTIME}")
target_compile_definitions(tflm PUBLIC FLATBUFFERS_USE_STD_SPAN)

add_executable(fan_replay fan_replay.cpp)
target_include_directories(fan_replay PRIVATE "${FIRMWARE}/include")
target_link_libraries(fan_replay PRIVATE tflm)
