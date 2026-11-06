<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo/owlet-lens-dark.svg">
    <img src="docs/assets/logo/owlet-lens.svg" alt="Owlet Lens" height="72">
  </picture>
</h1>

[English](./README.md) · **Tiếng Việt**

<p align="center">
  <img src="docs/assets/hero.vi.png" alt="Một thread review trong pull request: tool chỉ ra một lỗi, lập trình viên trả lời, và thread được đánh dấu là đã sửa rồi đóng lại" width="100%">
</p>

[![CI](https://github.com/openwt-vn/owlet-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/openwt-vn/owlet-lens/actions/workflows/ci.yml)
![Giấy phép: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)
![Node 20.10+](https://img.shields.io/badge/node-%E2%89%A520.10-339933)
![Nền tảng](https://img.shields.io/badge/platforms-GitHub%20%C2%B7%20GitLab%20%C2%B7%20Bitbucket%20%C2%B7%20Azure%20DevOps-c43727)

Công cụ review code bằng AI cho pull request. Tool đăng các phát hiện thành thread review ngay trên dòng code, đọc phản hồi của lập trình viên, và đóng những thread đã được sửa hoặc đã bị từ chối. Chạy trên GitHub (trang này), cùng Bitbucket Cloud, GitLab và Azure DevOps ([các nền tảng hỗ trợ](#các-nền-tảng-hỗ-trợ)).

Được xây dựng và sử dụng tại OpenWT Vietnam.

## Vì sao dùng

- **Biết trả lời.** Đọc từng phản hồi của lập trình viên và quyết định: đã sửa, sẽ không sửa, hay vẫn còn mở.
- **Tự dọn dẹp.** Thread đã sửa tự đóng, lỗi tái phát tự mở lại, nên danh sách thread luôn khớp với code.
- **Biết học.** Những phát hiện mà đội ngũ liên tục từ chối được đề xuất thành quy tắc chuẩn code, trong một pull request do người duyệt.
- **Chạy ở nơi bạn đang làm việc.** Bốn nền tảng, nhiều nhà cung cấp AI (kể cả mô hình chạy cục bộ), và không có gì để tự vận hành: không database, không server.

## Cách hoạt động

![Luồng hoạt động: mở pull request, phát hiện thành thread, trả lời trong thread, thread tự đóng](docs/assets/how-it-works.vi.png)

1. **Review** (khi mở hoặc push PR): gửi diff cho LLM, đăng các phát hiện mới, trả lời ở những thread còn mở, mở lại thread khi lỗi tái phát, đóng thread đã sửa, và luôn cập nhật một comment tổng hợp.
2. **Reply** (khi lập trình viên trả lời trong thread review): LLM đọc cuộc trao đổi và quyết định `fixed`, `wontfix` hay `active`, rồi cập nhật thread.
3. **Learn** (theo lịch, tùy chọn): tìm những phát hiện mà đội ngũ liên tục từ chối và đề xuất quy tắc chuẩn code mới qua một pull request. Luôn có người duyệt; không có gì tự merge.

Không có database: trạng thái review nằm trong các marker ẩn bên trong comment, còn các quy tắc đã học nằm trong một file của repo.

## Bắt đầu nhanh (GitHub)

**1. Thêm một secret.** Repo → Settings → Secrets and variables → Actions → `ANTHROPIC_API_KEY` (nhà cung cấp khác: [bên dưới](#chọn-nhà-cung-cấp-llm)).

**2. Thêm file `.github/workflows/ai-review.yml`:**

```yaml
name: Owlet Lens
on:
  pull_request:
    types: [opened, synchronize, reopened]
  pull_request_review_comment:
    types: [created]

jobs:
  review:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest   # hoặc self-hosted
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # review cần toàn bộ lịch sử để so sánh diff
      - uses: openwt-vn/owlet-lens@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          subcommand: review

  reply:
    if: github.event_name == 'pull_request_review_comment' && github.event.comment.user.type != 'Bot'
    runs-on: ubuntu-latest   # hoặc self-hosted
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: openwt-vn/owlet-lens@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          subcommand: reply
```

Các câu trả lời được đọc từ comment **bên trong thread review** (`pull_request_review_comment`), không phải từ tab conversation của PR.

**3. Mở một pull request.** Các phát hiện xuất hiện thành thread review trong một đến hai phút. Hãy trả lời trong thread để trao đổi.

**Thử mà không ảnh hưởng tới pull request của bạn.** Thêm `dry-run: 'true'` dưới `with:`, lần chạy sẽ in ra những gì nó định đăng mà không đăng gì cả. Bỏ dòng này đi khi bạn đã hài lòng.

## Chọn nhà cung cấp LLM

Review và reply mỗi bên chọn một nhà cung cấp, nên bạn có thể dùng mô hình mạnh hơn cho review và mô hình rẻ hơn cho reply.

| Nhà cung cấp | Input của Action | Ghi chú |
|---|---|---|
| Anthropic (mặc định) | `anthropic-api-key` | Mặc định: review `claude-opus-4-7`, reply `claude-haiku-4-5-20251001` |
| Gemini | `gemini-api-key` | Đặt `review-provider: gemini` |
| DeepSeek | `deepseek-api-key` | Đặt `review-provider: deepseek` |
| ModelStack (cổng tương thích OpenAI) | `modelstack-api-key` | Không có bảng giá sẵn: chi phí hiển thị `$0` trừ khi bạn thêm khối `pricing:` |
| Bất kỳ endpoint tương thích OpenAI nào, kể cả mô hình cục bộ | khóa cấu hình `review.apiBaseUrl` | Với mô hình cục bộ, key có thể để trống |

Để dùng nhà cung cấp khác mặc định, thay `anthropic-api-key` ở **cả hai** job và ghi rõ tên model:

```yaml
        with:
          gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
          review-provider: gemini
          reply-provider: gemini
          review-model: <một model mà nhà cung cấp của bạn có>
          reply-model: <một model mà nhà cung cấp của bạn có>
          subcommand: review   # hoặc reply
```

Tên model mà nhà cung cấp không chấp nhận sẽ làm mọi lần gọi đều lỗi. Model dự phòng, bảng giá và mọi khóa khác nằm trong [tài liệu cấu hình](./docs/config.md#llm-providers).

## Cần biết

- **Pull request từ fork không nhận được secret.** GitHub không truyền secret của repo cho workflow được kích hoạt từ fork, nên review sẽ không chạy cho người đóng góp bên ngoài. Đừng vòng qua giới hạn này bằng `pull_request_target` nếu bạn chưa hiểu rủi ro của việc chạy code không đáng tin cậy cùng với secret của bạn.
- **Chi phí.** Một pull request thông thường mất khoảng hai lần gọi model, và một lần push không làm thay đổi nội dung cần review sẽ bị bỏ qua. Chi phí thực tế phụ thuộc vào model và kích thước diff; comment tổng hợp có báo cáo chi phí.
- **Ghim phiên bản.** `@v1` đi theo bản 1.x mới nhất. Để chạy lặp lại được, hãy ghim một tag cụ thể như `@v1.0.0`, hoặc một mã commit SHA đầy đủ.

## Quyền riêng tư và bảo mật

Tool gửi code của bạn tới nhà cung cấp LLM mà bạn chọn, nên hãy cân nhắc kỹ.

- **Được gửi:** diff của pull request, các file mà diff import, các file bạn liệt kê trong `review.contextPaths` và `review.codingStandardsPath`, và các câu trả lời của lập trình viên mà tool cần đánh giá.
- **Được lọc:** các chuỗi có hình dạng của secret (khóa API, token, mật khẩu, chuỗi kết nối, khóa riêng) được thay bằng `[REDACTED]` trong diff, file được import, câu trả lời và dữ liệu đầu vào của learn trước khi gửi. Đây là so khớp theo mẫu, không phải bảo đảm: một secret có hình dạng lạ vẫn lọt qua.
- **Không được lọc:** nội dung của `contextPaths` và các file chuẩn code được gửi nguyên văn. Hãy giữ secret ra khỏi các file này.
- **Model dự phòng** có thể đưa code của bạn tới một nhà cung cấp khác. Hãy xem xét mọi model bạn liệt kê.

Chi tiết theo từng nhà cung cấp: [chính sách dữ liệu LLM](./docs/llm-data-policy.md).

## Các nền tảng hỗ trợ

| Nền tảng | Ghi chú | Hướng dẫn |
|---|---|---|
| GitHub | GitHub Action, đầy đủ tính năng | trang này |
| GitLab | GitLab.com và tự host, mẫu CI | [docs/gitlab-setup.md](./docs/gitlab-setup.md) |
| Bitbucket Cloud | Chỉ bản Cloud; không hỗ trợ Server và Data Center | [Cài đặt nhà cung cấp](./docs/usage.md#review-provider-github-bitbucket-gitlab-or-azure-devops) |
| Azure DevOps | Services và Server | [Cài đặt nhà cung cấp](./docs/usage.md#review-provider-github-bitbucket-gitlab-or-azure-devops) |

## Một lần chạy trông như thế nào

<details>
<summary>Ví dụ comment tổng hợp (số liệu minh họa)</summary>

```
### [Owlet Lens] Summary

PR: #42 - Add refund endpoint
Findings: 3 new · 1 replied · 0 reopened · 1 closed
Cost: $0.0812 (1 call(s))
Severity: 1 HIGH · 2 MEDIUM
Files: 6 reviewed
```

Bot giữ một comment tổng hợp cho mỗi pull request và cập nhật nó sau mỗi lần push. Mỗi phát hiện là một thread riêng trên đúng dòng code liên quan. Nội dung comment của bot hiện bằng tiếng Anh.

</details>

## Câu hỏi thường gặp

- **Nó có thay thế review của con người không?** Không. Nó là lượt xem xét đầu tiên, bắt các vấn đề thông thường, để người review dành thời gian cho thiết kế và logic nghiệp vụ. Con người vẫn là người duyệt và merge.
- **Code của tôi có an toàn không?** Xem [Quyền riêng tư và bảo mật](#quyền-riêng-tư-và-bảo-mật): bạn chọn nhà cung cấp, các chuỗi giống secret được lọc, và chi tiết nằm trong [chính sách dữ liệu LLM](./docs/llm-data-policy.md).
- **Tôi có dùng được mô hình cục bộ không?** Có. Mọi endpoint tương thích OpenAI đều dùng được, kể cả các mô hình cục bộ như Ollama ([tài liệu cấu hình](./docs/config.md#llm-providers)).
- **Chi phí bao nhiêu?** Xem [Cần biết](#cần-biết). Comment tổng hợp cho biết chi phí của từng lần chạy.

## Tùy chỉnh

Tùy chọn: thêm `ai-review.config.yaml` ở thư mục gốc của repo (model, ngưỡng mức độ, đường dẫn cần bỏ qua, chuẩn code). Hãy bắt đầu từ [file cấu hình mẫu](./examples/ai-review.config.yaml). Mọi khóa đều có trong [tài liệu cấu hình](./docs/config.md).

| Bạn muốn… | Xem ở đâu |
|---|---|
| Làm CI thất bại khi có phát hiện nghiêm trọng (`strict`) | [Tài liệu sử dụng](./docs/usage.md#strict-mode) |
| Cho bot bật nút "Resolved" của GitHub | [Quyền của token](./docs/usage.md#limitations--token-permissions) |
| Mọi input và output của Action, ghim phiên bản | [Tài liệu sử dụng](./docs/usage.md#inputs) |
| Dùng LLM khác hoặc giảm nhiễu | [docs/config.md](./docs/config.md) |
| Biết cái gì được gửi tới LLM | [Chính sách dữ liệu LLM](./docs/llm-data-policy.md) |

## Đóng góp

Xem [CONTRIBUTING.md](./CONTRIBUTING.md). Mục lục tài liệu: [docs/README.md](./docs/README.md).

Các tài liệu chi tiết trong thư mục `docs/` hiện chỉ có bằng tiếng Anh.

## Giấy phép

Phát hành theo [Apache License 2.0](./LICENSE). Bản quyền 2026 Open Web Technology Vietnam LLC.

Tên Owlet Lens và logo của dự án không nằm trong phạm vi giấy phép (xem điều 6 của giấy phép và [TRADEMARKS.md](./TRADEMARKS.md)). Tên và logo của các nền tảng thuộc về chủ sở hữu của chúng và chỉ được dùng để thể hiện khả năng tương thích; xem [NOTICE](./NOTICE).
