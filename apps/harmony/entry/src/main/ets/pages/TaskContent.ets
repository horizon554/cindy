import { Row as Item, Card, Question, Choice, MediaInfo } from '../services/workspace';
import { pasteboard } from '@kit.BasicServicesKit';
import { PillAction } from './Controls';

import { messageBlocks, messageSpans, MessageBlock, MessageSpan } from '../services/taskModel';

@Component
export struct MessageBody {
  @Prop value: string = '';
  openLink: (url: string) => void = () => {};
  private async copy(value: string): Promise<void> {
    try {
      await pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, value));
      this.getUIContext().getPromptAction().showToast({ message: $r('app.string.copied') });
    } catch { this.getUIContext().getPromptAction().showToast({ message: $r('app.string.copy_failed') }); }
  }

  build() {
    Column({ space: 7 }) {
      ForEach(messageBlocks(this.value), (b: MessageBlock) => {
        if (b.kind === 'code') {
          Column() {
          Button($r('app.string.copy_code')).height(44).alignSelf(ItemAlign.End).fontSize(13).fontColor($r('app.color.muted'))
            .backgroundColor(Color.Transparent).onClick(() => this.copy(b.text))
          Text(b.text).fontFamily('monospace').fontSize(14).lineHeight(20).padding(10)
            .width('100%').borderRadius(8).backgroundColor($r('app.color.chip'))
            .fontColor($r('app.color.ink')).copyOption(CopyOptions.InApp)
          }.width('100%').backgroundColor($r('app.color.chip')).borderRadius(8)
        } else if (b.kind === 'table') {
          Column() {
            Button($r('app.string.copy_table')).height(44).alignSelf(ItemAlign.End).fontSize(13).fontColor($r('app.color.muted'))
              .backgroundColor(Color.Transparent).onClick(() => this.copy(b.text))
            Scroll() {
              Column() {
                ForEach(b.rows || [], (row: string[], i: number) => {
                  Row() {
                    ForEach(row, (cell: string, j: number) => {
                      Text(cell).width(132).padding(8).fontSize(14).fontColor($r('app.color.ink')).fontWeight(i === 0 ? FontWeight.Bold : FontWeight.Normal)
                    }, (cell: string, j: number) => j.toString() + cell)
                  }.alignSelf(ItemAlign.Start).borderWidth({ bottom: 1 }).borderColor($r('app.color.line'))
                }, (row: string[], i: number) => i.toString() + row.join('|'))
              }
            }.scrollable(ScrollDirection.Horizontal).width('100%')
          }.width('100%').backgroundColor($r('app.color.panel')).borderRadius(8)
        } else {
          Text() {
            ForEach(messageSpans(b.text), (s: MessageSpan) => {
              if (s.url) {
                Span(s.text).decoration({ type: TextDecorationType.Underline }).onClick(() => this.openLink(s.url!))
              } else {
                Span(s.text).fontWeight(s.bold || b.kind === 'heading' ? FontWeight.Medium : FontWeight.Normal)
                  .fontFamily(s.code ? 'monospace' : 'sans-serif')
              }
            })
          }.fontSize(b.kind === 'heading' ? 19 : 16).lineHeight(b.kind === 'heading' ? 28 : 24)
            .fontColor(b.kind === 'quote' ? $r('app.color.muted') : $r('app.color.ink')).copyOption(CopyOptions.InApp)
            .padding({ left: b.kind === 'quote' ? 12 : 0 }).borderWidth({ left: b.kind === 'quote' ? 2 : 0 }).borderColor($r('app.color.line'))
        }
      }, (block: MessageBlock, index: number) => index.toString() + block.kind + block.text)
    }.width('100%').alignItems(HorizontalAlign.Start)
  }
}

@Component
struct HistoryAttachment {
  @Prop file: MediaInfo = { name: '' };
  @State imageSource: string = '';
  private visible: boolean = false;
  load: (file: MediaInfo, visible: () => boolean) => Promise<string> = async () => '';
  preview: (file: MediaInfo) => void = () => {};

  build() {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 8 }) {
        if (this.imageSource) {
          Image(this.imageSource).width(62).height(62).borderRadius(8).objectFit(ImageFit.Cover)
        } else {
          SymbolGlyph(this.file.mimeType?.startsWith('image/') ? $r('sys.symbol.picture') : $r('sys.symbol.doc')).fontSize(19)
        }
        Text(this.file.name).maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis }).fontSize(14).fontColor($r('app.color.ink'))
      }.padding(8)
    }.constraintSize({ minHeight: 44 }).borderRadius(8).backgroundColor($r('app.color.chip')).onClick(() => this.preview(this.file))
      .onVisibleAreaChange([0, 0.1], (visible: boolean, ratio: number) => {
        this.visible = visible && ratio > 0;
        if (this.visible && !this.imageSource && this.file.mimeType?.startsWith('image/')) {
          this.load(this.file, () => this.visible).then((source: string) => { if (this.visible) this.imageSource = source; });
        }
      })
  }

  aboutToDisappear(): void { this.visible = false; }
}

@Component
export struct HistoryMessage {
  @Prop item: Item = { id: '', title: '' };

  @State expanded: boolean = false;
  openLink: (url: string) => void = () => {};
  loadImage: (file: MediaInfo, visible: () => boolean) => Promise<string> = async () => '';
  preview: (file: MediaInfo) => void = () => {};

  @Builder
  media() {
    ForEach(this.item.media || [], (f: MediaInfo) => {
      HistoryAttachment({ file: f, load: this.loadImage, preview: this.preview })
    })
  }

  private activityLabel(): Resource {
    if (this.item.role === 'tool_use') return $r('app.string.tool_request');
    if (this.item.role === 'tool_result') return $r('app.string.tool_result');
    if (this.item.role === 'permission') return $r('app.string.permission');
    if (this.item.role === 'ask_user') return $r('app.string.ask');
    return $r('app.string.task_record');
  }

  build() {
    if (this.item.role === 'user') {
      Row() {
        Column({ space: 6 }) {
          if (this.item.messageText !== '' || !this.item.media?.length) {
            Text(this.item.messageText ?? this.item.title).fontSize(16).lineHeight(24)
              .fontColor($r('app.color.ink')).copyOption(CopyOptions.InApp)
          }
          this.media()
        }.alignItems(HorizontalAlign.Start).padding({ left: 12, right: 12, top: 8, bottom: 8 })
          .backgroundColor($r('app.color.panel')).borderWidth(0.5).borderColor($r('app.color.line'))
          .borderRadius(12).constraintSize({ maxWidth: '86%' })
      }.width('100%').justifyContent(FlexAlign.End)
    } else if (this.item.role === 'assistant') {
      Column({ space: 4 }) {
        MessageBody({ value: this.item.messageText ?? this.item.title, openLink: this.openLink })
        this.media()
      }.alignItems(HorizontalAlign.Start).width('100%')
    } else {
      Column({ space: 4 }) {
        Button({ type: ButtonType.Normal }) {
          Row({ space: 8 }) {
            SymbolGlyph(this.expanded ? $r('sys.symbol.chevron_down') : $r('sys.symbol.chevron_right')).fontSize(13)
            Text(this.activityLabel()).fontSize(13).fontWeight(FontWeight.Medium).fontColor($r('app.color.muted'))
            Text(this.item.title).maxLines(1).layoutWeight(1).textOverflow({ overflow: TextOverflow.Ellipsis })
              .fontSize(14).fontColor($r('app.color.ink'))
          }.width('100%')
        }.width('100%').height(44).backgroundColor(Color.Transparent).onClick(() => { this.expanded = !this.expanded; })
        if (this.expanded) {
          Text(this.item.detail || this.item.title).fontSize(14).lineHeight(20).fontColor($r('app.color.ink')).copyOption(CopyOptions.InApp)
        }
      }.alignItems(HorizontalAlign.Start).width('100%').padding({ left: 12, top: 3, bottom: 3 })
        .borderWidth({ left: 2 }).borderColor($r('app.color.line'))
    }
  }
}

@Component
export struct InteractionPanel {
  @Prop card: Card = { id: '', revision: 0, kind: '', title: '', detail: '', questions: [] };
  @Prop available: boolean = true;
  edit: (key: string, value: string, select: boolean) => void = () => {};
  openLink: (url: string) => void = () => {};
  @State armed: string = '';
  @State showPlan: boolean = false;
  @State step: number = 0;
  decide: (choice: string, key?: string) => void = () => {};

  @Builder
  planReader() {
    Column({ space: 12 }) {
      Text(this.card.title).fontSize(20).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink'))
      Scroll() { MessageBody({ value: this.card.detail, openLink: this.openLink }) }
        .layoutWeight(1).width('100%').align(Alignment.TopStart)
      Row({ space: 8 }) {
        PillAction({ label: $r('app.string.deny'), available: this.available, onTap: () => this.decide('deny') })
        PillAction({ label: $r('app.string.approve_plan'), prominent: true, available: this.available, onTap: () => this.decide('allow') })
      }
    }.width('100%').height('100%').padding(16).backgroundColor($r('app.color.canvas'))
  }

  build() {
    Column({ space: 10 }) {
      Text(this.armed && this.card.approvalKey === this.armed ? $r('app.string.review_risk') : this.card.title).fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink'))
      Scroll() {
        Column({ space: 8 }) {
          if (this.armed && this.card.approvalKey === this.armed) {
            Text($r('app.string.risk_notice')).fontSize(15).fontWeight(FontWeight.Bold).fontColor($r('app.color.warning'))
          }
          if (this.card.risk) { Text(this.card.risk).fontSize(15).fontWeight(FontWeight.Medium).fontColor($r('app.color.warning')) }
          if (this.card.code) { Text(this.card.code).fontFamily('monospace').fontSize(14).padding(8).backgroundColor($r('app.color.chip')).copyOption(CopyOptions.InApp) }
          if (this.card.kind === 'plan_review') {
            Text(this.card.detail).maxLines(3).textOverflow({ overflow: TextOverflow.Ellipsis })
            PillAction({ label: $r('app.string.expand_plan'), onTap: () => { this.showPlan = true; } })
              .bindSheet($$this.showPlan, this.planReader, { height: SheetSize.LARGE, showClose: true, dragBar: true })
          } else if (this.card.detail) {
            Text(this.card.detail).width('100%').fontSize(14).fontColor($r('app.color.muted')).copyOption(CopyOptions.InApp)
          }
          if (this.card.kind === 'ask_user_question') {
            ForEach(this.card.questions.slice(this.step, this.step + 1), (q: Question) => {
              Column({ space: 5 }) {
                if (this.card.questions.length > 1) {
                  Text((this.step + 1).toString() + ' / ' + this.card.questions.length.toString()).fontSize(13).fontColor($r('app.color.muted'))
                }
                Text(q.label).fontSize(15).fontColor($r('app.color.ink'))
                ForEach(q.options, (o: Choice) => {
                  Button({ type: ButtonType.Normal }) {
                    Row({ space: 8 }) {
                      Column({ space: 2 }) {
                        Text(o.label).fontSize(15).fontColor($r('app.color.ink'))
                        if (o.detail) { Text(o.detail).fontSize(13).fontColor($r('app.color.muted')) }
                      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
                      Stack() {
                        if (o.selected) {
                          if (q.multi) { SymbolGlyph($r('sys.symbol.checkmark')).fontSize(14) }
                          else { Circle().width(10).height(10).fill($r('app.color.ink')) }
                        }
                      }.width(20).height(20).borderWidth(1).borderColor($r('app.color.muted')).borderRadius(q.multi ? 4 : 10)

                    }.width('100%').padding({ left: 12, right: 12, top: 7, bottom: 7 })
                  }.width('100%').constraintSize({ minHeight: 44 }).borderRadius(8)
                    .backgroundColor(o.selected ? $r('app.color.chip') : $r('app.color.canvas'))
                    .accessibilityDescription(o.selected ? $r('app.string.choice_selected') : $r('app.string.choice_unselected')).enabled(this.available).onClick(() => this.edit(q.key, o.label, true))
                }, (o: Choice) => o.label)
                if (q.free) {
                  TextInput({ text: q.value, placeholder: $r('app.string.answer') }).accessibilityText(q.label)
                    .enabled(this.available).onChange((v: string, preview?: PreviewText) => {
                      if (!preview?.value) this.edit(q.key, v, false);
                    })
                }
              }.width('100%').alignItems(HorizontalAlign.Start)
            }, (q: Question) => q.key)
          }
        }.width('100%').alignItems(HorizontalAlign.Start)
      }.constraintSize({ maxHeight: this.showPlan ? '80%' : '55%' }).width('100%')
      if (this.card.kind === 'ask_user_question') {
        Row({ space: 8 }) {
          if (this.step > 0) { PillAction({ label: $r('app.string.previous'), onTap: () => { this.step--; } }) }
          if (this.step < this.card.questions.length - 1) {
            PillAction({ label: $r('app.string.next_step'), prominent: true, available: this.available && !!this.card.questions[this.step]?.valid, onTap: () => { this.step++; } })
          } else {
            PillAction({ label: $r('app.string.submit_answer'), prominent: true, available: this.available && !!this.card.complete, onTap: () => this.decide('answer') })
          }
        }
      } else if (this.card.kind === 'permission' || this.card.kind === 'plan_review') {
        Row({ space: 8 }) {
          PillAction({ label: $r('app.string.deny'), available: this.available, onTap: () => this.decide('deny') })
          PillAction({ label: this.card.kind === 'permission' ? (this.card.approvalKey && this.armed === this.card.approvalKey ? $r('app.string.confirm_risk') : $r('app.string.allow_once')) : $r('app.string.approve_plan'),
            prominent: true, available: this.available, onTap: () => {
              if (this.card.approvalKey && this.armed !== this.card.approvalKey) { this.armed = this.card.approvalKey; return; }
              const key = this.armed;
              this.armed = '';
              this.decide('allow', key);
            } })
        }
      }
    }.width('100%').alignItems(HorizontalAlign.Start).padding(12).borderRadius(12)
      .borderWidth(1).borderColor($r('app.color.line')).backgroundColor($r('app.color.panel'))
  }
}
