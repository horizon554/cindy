import { Row as Item, Card, Question, Choice } from '../services/workspace';
import { PillAction } from './Controls';

@Component
export struct HistoryMessage {
  @Prop item: Item = { id: '', title: '' };

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
        Text(this.item.title).fontSize(16).fontColor($r('app.color.ink')).copyOption(CopyOptions.InApp)
          .padding({ left: 14, right: 14, top: 10, bottom: 10 }).backgroundColor($r('app.color.chip'))
          .borderRadius(12).constraintSize({ maxWidth: '90%' })
      }.width('100%').justifyContent(FlexAlign.End)
    } else if (this.item.role === 'assistant') {
      Text(this.item.title).fontSize(16).lineHeight(24).fontColor($r('app.color.ink'))
        .width('100%').copyOption(CopyOptions.InApp)
    } else {
      Column({ space: 4 }) {
        Text(this.activityLabel()).fontSize(12).fontWeight(FontWeight.Medium).fontColor($r('app.color.faint'))
        Text(this.item.title).fontSize(14).fontColor($r('app.color.muted')).copyOption(CopyOptions.InApp)
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
  decide: (choice: string) => void = () => {};

  build() {
    Column({ space: 10 }) {
      Text(this.card.title).fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink'))
      if (this.card.detail) {
        Text(this.card.detail).width('100%').fontSize(14).fontColor($r('app.color.muted')).copyOption(CopyOptions.InApp)
      }
      if (this.card.kind === 'ask_user_question') {
        ForEach(this.card.questions, (q: Question) => {
          Column({ space: 5 }) {
            Text(q.label).fontSize(15).fontColor($r('app.color.ink'))
            ForEach(q.options, (o: Choice) => {
              Button({ type: ButtonType.Normal }) {
                Row({ space: 8 }) {
                  Column({ space: 2 }) {
                    Text(o.label).fontSize(15).fontColor($r('app.color.ink'))
                    if (o.detail) { Text(o.detail).fontSize(13).fontColor($r('app.color.muted')) }
                  }.alignItems(HorizontalAlign.Start).layoutWeight(1)
                  if (o.selected) { SymbolGlyph($r('sys.symbol.checkmark')).fontSize(16).fontColor([$r('app.color.ink')]) }
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
        PillAction({ label: $r('app.string.submit_answer'), prominent: true, available: this.available, onTap: () => this.decide('answer') })
      } else if (this.card.kind === 'permission' || this.card.kind === 'plan_review') {
        Row({ space: 8 }) {
          PillAction({ label: $r('app.string.deny'), available: this.available, onTap: () => this.decide('deny') })
          PillAction({ label: this.card.kind === 'permission' ? $r('app.string.allow_once') : $r('app.string.approve_plan'),
            prominent: true, available: this.available, onTap: () => this.decide('allow') })
        }
      }
    }.width('100%').alignItems(HorizontalAlign.Start).padding(12).borderRadius(12)
      .borderWidth(1).borderColor($r('app.color.line')).backgroundColor($r('app.color.panel'))
  }
}
