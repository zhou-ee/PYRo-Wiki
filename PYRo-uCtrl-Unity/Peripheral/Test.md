Version<Badge type ="tip" text="1.0.0"/>  
File<Badge type = "info" text="pyro_bsp_can.h"/><Badge type = "info" text="pyro_bsp_can.cpp"/><Badge type = "info" text="pyro_can_drv.h"/><Badge type = "info" text="pyro_can_drv.cpp"/>

# PYRo CAN Driver

这是一个基于 STM32 HAL 库 **FDCAN (Flexible Data-rate CAN)** 外设的 CAN 总线通信驱动。该库采用 C++ 静态单例模式封装，提供线程安全的消息收发、消息缓冲区注册管理、总线离线自动恢复等功能，适用于机器人多节点实时通信场景。
> 嵌入式开发前置知识：了解 CAN 总线协议及 STM32 FDCAN 外设

## Part 1: 代码详解 (Code Explanation)

### 1. 核心设计理念

- **BSP + 驱动分层架构**: `can_drv_t` 负责核心 FDCAN 硬件操作和消息路由逻辑；`bsp_can` 作为板级支持层，管理 CAN1/CAN2/CAN3 三个硬件实例的创建与初始化。两者通过 `friend class` 解耦，外部代码只能通过 `bsp_can` 获取驱动实例，确保实例的唯一性和生命周期安全。

- **消息缓冲区注册机制 (`can_msg_buffer_t`)**: 每个需要接收 CAN 消息的模块创建自己的 `can_msg_buffer_t`，通过 ID 注册到 `can_drv_t` 的内部注册表 `_registerlist` 中。当硬件中断触发时，驱动根据消息 ID 查找对应的缓冲区并自动更新数据，实现"发布-订阅"式的消息分发。

### 2. 关键实现机制

#### A. 消息缓冲区 (`can_msg_buffer_t`)
