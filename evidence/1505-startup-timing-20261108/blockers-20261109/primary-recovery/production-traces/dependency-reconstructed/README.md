# 0e daemon/E2B 依赖审恢复说明（重建文档，非原字节）

固定0e4118020311ae8f9083d0d21cfb990be0282f25，tree72f1661362ceaefde626fa7402116ae8f8ad7417。daemon Seal exact candidate失败阻断自己的npm package工作流，不是E2B发布依赖。E2B独立经过test/check/validate/await-web/subscriptions/reusable Web publish和cleanup；await-web只查匹配Web/publicsource/main。模板bootstrap精确Git checkout→filtered frozen install→cloud worker build，不消费新npm发布包。实际daemon首因未知，没有读rawlog；独立依赖也不保证E2B成功。

0a→0e共28路径，与1788旧六仅两Desktop readiness交点，四daemon无交点；Factory metadata三路径均无交点。只核路径集合，未额外断言readiness blob等于79aa。已缓存1752/1506评论没有daemon seal明确owner/repair声明，不外推全站无人负责。

原manifest900B/SHA79a78ebee45ae46be51c23af8bf83dbba375c4dbdf94af0f11c84c596b571487。原review.json/review.md/source-index/manifest原序列化未保留；现source-index是从已经缓存的精确source响应提取blob指针的新投影，不含源码全文，也不是原文件。无新API/模型/SQL/PRIMARY重试。
