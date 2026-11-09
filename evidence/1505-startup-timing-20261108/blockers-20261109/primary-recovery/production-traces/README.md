# PRIMARY 失联后的有限恢复

本目录于2026-11-09从functions store和保留上下文写入现有云VM；没有重试失联PRIMARY，也没有重新下载源码、日志、工件或生产数据。

精确原字节已恢复：main-0e-boundary/metadata.json 59784B、review.md 5102B，分别与旧SHA85bd296d…aa4fb、b04935e8…d2aff完全匹配。reconstructed-comments.json来自完整已缓存parsed comments；当前17927B/SHA7c2466…a3e1，旧原件19167B/SHA983cf1…af58未恢复，不能冒称原字节。

MCP及daemon/E2B依赖报告以明确标注的重建说明保存；缓存source blob指针和交集也作为新投影保留。原manifest和stage-index原字节不能保全，已在original-known-hashes.json逐项列旧bytes/SHA与restored:false。Factory、peer、production-0a由root/其他agent另行恢复，不在此重复。rules-verbatim及Git源码/patch仍排除。

保留旧FAIL/unknown。静态MCP缺口不是生产唯一因果实证；daemon seal独立不等于E2B成功；新正式样本仍0。本目录只作为后续独立Git证据增量，不冒称原51文件staging完整恢复。
