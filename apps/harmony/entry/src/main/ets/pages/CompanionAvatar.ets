import { Companion } from '../services/workspace';

export function companionPortraitKey(row: Companion): string {
  return JSON.stringify([row.key, row.title, row.avatar, row.preset, row.avatarImage, row.cloudImage, row.actor,
    row.faces?.map((member: Companion) => [member.key, member.avatar, member.preset, member.cloudImage, member.avatarImage])]);
}

@Component
struct Portrait {
  portraitSize: number = 32;
  row: Companion = { key: '', host: '', id: '', title: '', avatar: '' };
  load: (row: Companion, visible: () => boolean) => Promise<string> = async () => '';
  @State private source: string = '';
  private visible: boolean = false;
  private revision: number = 0;

  private setOnScreen(onScreen: boolean): void {
    if (this.visible === onScreen) return;
    this.visible = onScreen;
    const revision = ++this.revision;
    if (!onScreen || this.row.preset || this.source || (!this.row.avatarImage && !this.row.cloudImage)) return;
    const current = (): boolean => this.visible && this.revision === revision;
    this.load(this.row, current).then((uri: string) => { if (current()) this.source = uri; });
  }

  aboutToDisappear(): void { this.setOnScreen(false); }

  build() {
    Stack() {
      if (this.row.preset) {
        Image(this.row.preset === 'cindy' ? $r('app.media.buddy_cindy') : this.row.preset === 'dash' ? $r('app.media.buddy_dash') : $r('app.media.buddy_lizi'))
          .width('100%').height('100%').objectFit(ImageFit.Cover)
      } else if (this.source) {
        Image(this.source).id('companion-avatar-image').width('100%').height('100%').objectFit(ImageFit.Cover)
          .onError(() => { this.source = ''; })
      } else {
        Text(this.row.avatar).fontSize(this.portraitSize * 0.5).fontColor($r('app.color.ink')).textAlign(TextAlign.Center)
      }
    }.width(this.portraitSize).height(this.portraitSize).borderRadius(this.portraitSize / 2).clip(true).backgroundColor($r('app.color.chip')).accessibilityLevel('no')
      .onVisibleAreaChange([0], (visible: boolean, ratio: number) => { this.setOnScreen(visible && ratio > 0); })
  }
}

@Component
export struct CompanionAvatar {
  row: Companion = { key: '', host: '', id: '', title: '', avatar: '' };
  portraitSize: number = 32;
  load: (row: Companion, visible: () => boolean) => Promise<string> = async () => '';

  private diameter(count: number): number {
    if (count === 1) return this.portraitSize;
    if (count === 2) return this.portraitSize * 0.69 + 4;
    return this.portraitSize * (count === 3 ? 0.6 : count === 4 ? 0.55 : 0.5);
  }

  private memberOffset(count: number, i: number, horizontal: boolean): number {
    const remaining = this.portraitSize - this.diameter(count);
    if (count < 3) return i === 0 ? 0 : remaining;
    const angle = -3 * Math.PI / 4 + i * 2 * Math.PI / count;
    return remaining * (1 + (horizontal ? Math.cos(angle) : Math.sin(angle))) / 2;
  }

  build() {
    if (!this.row.group) {
      Portrait({ row: this.row, portraitSize: this.portraitSize, load: this.load })
    } else if (this.row.faces?.length) {
      Stack({ alignContent: Alignment.TopStart }) {
        ForEach(this.row.faces.slice().reverse(), (face: Companion, i: number) => {
          Stack() {
            Portrait({ row: face, portraitSize: this.diameter(this.row.faces!.length) - (this.row.faces!.length > 1 ? 4 : 0), load: this.load })
          }.width(this.diameter(this.row.faces!.length)).height(this.diameter(this.row.faces!.length))
            .borderRadius(this.portraitSize).backgroundColor($r('app.color.canvas'))
            .position({ x: this.memberOffset(this.row.faces!.length, i, true), y: this.memberOffset(this.row.faces!.length, i, false) })
        }, (face: Companion) => face.key)
      }.id('group-avatar-members').width(this.portraitSize).height(this.portraitSize).accessibilityLevel('no-hide-descendants')
    } else {
      Stack() {
        SymbolGlyph($r('sys.symbol.person_2')).fontSize(this.portraitSize * 0.6).fontColor([$r('app.color.muted')])
      }.width(this.portraitSize).height(this.portraitSize).borderRadius(this.portraitSize / 2).backgroundColor($r('app.color.chip')).accessibilityLevel('no')
    }
  }
}
