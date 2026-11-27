import { bundleManager } from '@kit.AbilityKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { OptionRow } from './Controls';

@Component
export struct SettingsPage {
  scroller: Scroller = new Scroller();
  @Prop account: string = '';
  @Prop email: string = '';
  @Prop avatar: string = '';
  @Prop relay: string = '';
  @Prop pushEnabled: boolean = false;
  @Prop pushStatus: string = '';
  @Prop busy: boolean = false;
  @State private version: string = '';
  @State private failedAvatar: string = '';
  @State private toggleRevision: number = 0;
  changePush: (enabled: boolean) => Promise<void> = async () => {};
  openNotifications: () => void = () => {};
  openPrivacy: () => void = () => {};
  openTerms: () => void = () => {};
  logout: () => void = () => {};

  aboutToAppear(): void {
    bundleManager.getBundleInfoForSelf(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT)
      .then((info: bundleManager.BundleInfo) => { this.version = info.versionName; })
      .catch(() => { this.version = ''; });
  }

  @Builder
  heading(title: Resource) {
    Text(title).fontSize(14).lineHeight(20).fontWeight(FontWeight.Medium).fontColor($r('app.color.muted'))
      .width('100%').padding({ left: 12, right: 12 }).accessibilityLevel('yes')
  }

  @Builder
  valueRow(label: Resource, value: ResourceStr, control: string) {
    Row({ space: 12 }) {
      Text(label).fontSize(16).lineHeight(23).fontColor($r('app.color.ink')).layoutWeight(1)
      Text(value).fontSize(15).lineHeight(21).fontColor($r('app.color.muted')).textAlign(TextAlign.End)
        .constraintSize({ maxWidth: '62%' })
    }.id(control).accessibilityGroup(true).width('100%').constraintSize({ minHeight: 48 })
      .padding({ left: 12, right: 12, top: 8, bottom: 8 })
  }

  @Builder
  identity() {
    Row({ space: 12 }) {
      Stack() {
        Text(Array.from(this.account.trim())[0] || 'C').fontSize(22).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink'))
        if (this.avatar && this.avatar !== this.failedAvatar) {
          ForEach([this.avatar], (url: string) => {
            Image(url).width(52).height(52).objectFit(ImageFit.Cover)
              .onError(() => { if (this.avatar === url) this.failedAvatar = url; })
          }, (url: string) => url)
        }
      }.width(52).height(52).backgroundColor($r('app.color.chip')).borderRadius(26).clip(true).accessibilityLevel('no-hide-descendants')
      Column({ space: 3 }) {
        Text(this.account).fontSize(20).lineHeight(26).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink'))
          .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
        if (this.email && this.email !== this.account) {
          Text(this.email).id('settings-email').fontSize(14).lineHeight(20).fontColor($r('app.color.muted'))
            .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        Row({ space: 6 }) {
          if (this.relay === 'connecting') {
            LoadingProgress().width(12).height(12).color($r('app.color.muted'))
          } else {
            Row().width(7).height(7).borderRadius(4).backgroundColor(this.relay === 'online' ? $r('app.color.ink') : $r('app.color.line'))
          }
          Text(this.relay === 'online' ? $r('app.string.settings_relay_online') :
            this.relay === 'connecting' ? $r('app.string.settings_relay_connecting') : $r('app.string.settings_relay_offline'))
            .id('settings-connection').fontSize(14).lineHeight(20).fontColor($r('app.color.muted'))
        }
      }.layoutWeight(1).alignItems(HorizontalAlign.Start)
    }.id('settings-identity').width('100%').padding(16).backgroundColor($r('app.color.panel')).borderRadius(14)
  }

  @Builder
  notifications() {
    ListItemGroup({ header: this.heading($r('app.string.settings_notifications_group')), style: ListItemGroupStyle.CARD }) {
      ListItem() {
        Row({ space: 12 }) {
          Text($r('app.string.notification_settings')).fontSize(16).lineHeight(23).fontColor($r('app.color.ink')).layoutWeight(1)
          ForEach([this.toggleRevision], (_rev: number) => {
            Toggle({ type: ToggleType.Switch, isOn: this.pushEnabled }).id('push-switch').enabled(!this.busy)
              .selectedColor($r('app.color.action')).accessibilityText($r('app.string.notification_settings'))
              .onChange(async (enabled: boolean) => {
                if (enabled !== this.pushEnabled && !this.busy) {
                  try { await this.changePush(enabled); } finally { this.toggleRevision++; }
                }
              })
          }, (rev: number) => rev.toString())
        }.width('100%').constraintSize({ minHeight: 48 }).padding({ left: 12, right: 12 })
      }
      ListItem() { OptionRow({ label: $r('app.string.settings_notifications'), action: this.openNotifications, control: 'system-notifications' }) }
      if (this.pushStatus) {
        ListItem() {
          Text(this.pushStatus).id('settings-push-status').fontSize(14).lineHeight(20).fontColor($r('app.color.muted'))
            .width('100%').padding(12)
        }
      }
    }.settingsDividers()
  }

  @Builder
  valueGroup(title: Resource, label: Resource, value: ResourceStr, control: string) {
    ListItemGroup({ header: this.heading(title), style: ListItemGroupStyle.CARD }) {
      ListItem() { this.valueRow(label, value, control) }
    }
  }

  build() {
    List({ space: 12, scroller: this.scroller }) {
      ListItem() { this.identity() }.padding({ left: 16, right: 16 })
      this.valueGroup($r('app.string.settings_relay'), $r('app.string.settings_current_relay'), $r('app.string.settings_official_relay'), 'settings-relay')
      ListItemGroup({ header: this.heading($r('app.string.settings_version')), style: ListItemGroupStyle.CARD }) {
        ListItem() {
          if (this.version) { this.valueRow($r('app.string.settings_current_version'), this.version, 'settings-version') }
          else { this.valueRow($r('app.string.settings_current_version'), '—', 'settings-version') }
        }
      }
      this.notifications()
      this.valueGroup($r('app.string.settings_appearance'), $r('app.string.settings_theme'), $r('app.string.settings_system_default'), 'settings-theme')
      this.valueGroup($r('app.string.settings_language'), $r('app.string.settings_language'), $r('app.string.settings_system_default'), 'settings-language')
      ListItemGroup({ header: this.heading($r('app.string.settings_about')), style: ListItemGroupStyle.CARD }) {
        if (deviceInfo.marketName || deviceInfo.productModel) {
          ListItem() { this.valueRow($r('app.string.settings_phone_model'), deviceInfo.marketName || deviceInfo.productModel, 'settings-phone') }
        }
        ListItem() { this.valueRow($r('app.string.settings_system'), deviceInfo.osFullName, 'settings-os') }
      }.settingsDividers()
      ListItemGroup({ header: this.heading($r('app.string.settings_legal')), style: ListItemGroupStyle.CARD }) {
        ListItem() { OptionRow({ label: $r('app.string.privacy'), action: this.openPrivacy, control: 'settings-privacy' }) }
        ListItem() { OptionRow({ label: $r('app.string.settings_agreement'), action: this.openTerms, control: 'settings-agreement' }) }
      }.settingsDividers()
      ListItem() {
        Button($r('app.string.sign_out'), { type: ButtonType.Normal }).id('settings-logout').width('100%')
          .constraintSize({ minHeight: 48 }).fontSize(16).fontColor($r('app.color.danger')).backgroundColor($r('app.color.panel'))
          .borderRadius(12).enabled(!this.busy).onClick(this.logout)
      }.padding({ left: 16, right: 16 })
    }.id('settings-scroll').width('100%').height('100%').scrollBar(BarState.Auto).contentStartOffset(4).contentEndOffset(12)
  }
}

@Extend(ListItemGroup) function settingsDividers() {
  .divider({ strokeWidth: 0.5, color: $r('app.color.line'), startMargin: 12, endMargin: 12 })
}
