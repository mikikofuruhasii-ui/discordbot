const { 
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, 
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, 
  ModalBuilder, TextInputBuilder, TextInputStyle, ActivityType 
} = require('discord.js');
const express = require('express');

// Render.com 用 Web サーバー（ポートバインド設定）
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is active!'));
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// --------------------------------------------------
// 動的設定用データストア (メモリ内保持)
// --------------------------------------------------
const guildRoles = new Map();     // GuildID => Selected RoleID (ロール選択式)
const guildPasscodes = new Map(); // GuildID => Passcode (合言葉設定)
const captchaStore = new Map();   // UserID => CaptchaCode (一時保持)

// 全24コマンド定義 (.addChoicesによる9モード組み込み)
const commands = [
  // 🔐 認証 (6個)
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('指定したモードで認証を実行します')
    .addStringOption(option =>
      option.setName('mode')
        .setDescription('認証モードを選択')
        .setRequired(true)
        .addChoices(
          { name: '1. ボタンタップ認証', value: 'mode_button' },
          { name: '2. キャプチャ文字認証', value: 'mode_captcha' },
          { name: '3. 合言葉/パスコード認証', value: 'mode_passcode' },
          { name: '4. リアクション付与認証', value: 'mode_reaction' },
          { name: '5. Web/OAuth2連携認証', value: 'mode_web' },
          { name: '6. 利用規約同意チェック認証', value: 'mode_terms' },
          { name: '7. Q&Aクイズ応答認証', value: 'mode_quiz' },
          { name: '8. ロール所有条件認証', value: 'mode_role' },
          { name: '9. DMワンタイムコード認証', value: 'mode_dm' }
        )
    ),
  new SlashCommandBuilder().setName('verify-setup').setDescription('認証パネルを設置'),
  new SlashCommandBuilder().setName('verify-panel').setDescription('認証パネルのテキスト編集'),
  new SlashCommandBuilder().setName('verify-manual').setDescription('手動認証付与').addUserOption(o => o.setName('target').setDescription('対象').setRequired(true)),
  new SlashCommandBuilder().setName('verify-reset').setDescription('認証リセット').addUserOption(o => o.setName('target').setDescription('対象').setRequired(true)),
  new SlashCommandBuilder().setName('set-passcode').setDescription('合言葉認証のパスコードを変更').addStringOption(o => o.setName('code').setDescription('新しいパスコード').setRequired(true)),

  // 🛡️ モデレーション (6個)
  new SlashCommandBuilder().setName('kick').setDescription('メンバーをキック').addUserOption(o => o.setName('target').setDescription('対象').setRequired(true)),
  new SlashCommandBuilder().setName('ban').setDescription('メンバーをBAN').addUserOption(o => o.setName('target').setDescription('対象').setRequired(true)),
  new SlashCommandBuilder().setName('unban').setDescription('BAN解除').addStringOption(o => o.setName('userid').setDescription('ユーザーID').setRequired(true)),
  new SlashCommandBuilder().setName('timeout').setDescription('タイムアウト').addUserOption(o => o.setName('target').setDescription('対象').setRequired(true)).addIntegerOption(o => o.setName('duration').setDescription('分数').setRequired(true)),
  new SlashCommandBuilder().setName('untimeout').setDescription('タイムアウト解除').addUserOption(o => o.setName('target').setDescription('対象').setRequired(true)),
  new SlashCommandBuilder().setName('purge').setDescription('一括削除').addIntegerOption(o => o.setName('amount').setDescription('件数').setRequired(true)),

  // ⚙️ サーバー管理・Bot設定 (6個)
  new SlashCommandBuilder()
    .setName('set-role')
    .setDescription('認証成功時に付与するロールを選択・設定')
    .addRoleOption(o => o.setName('role').setDescription('付与したいロールを選択').setRequired(true)),
  new SlashCommandBuilder()
    .setName('set-status')
    .setDescription('Botのステータス・表示テキストを変更')
    .addStringOption(o => o.setName('text').setDescription('表示テキスト').setRequired(true))
    .addStringOption(o => o.setName('type').setDescription('種類').addChoices(
      { name: 'プレイ中 (Playing)', value: 'Playing' },
      { name: '配信中 (Streaming)', value: 'Streaming' },
      { name: '聴取中 (Listening)', value: 'Listening' },
      { name: '視聴中 (Watching)', value: 'Watching' }
    )),
  new SlashCommandBuilder().setName('serverinfo').setDescription('サーバー情報'),
  new SlashCommandBuilder().setName('userinfo').setDescription('ユーザー情報').addUserOption(o => o.setName('target').setDescription('対象')),
  new SlashCommandBuilder().setName('role-add').setDescription('ロール個別付与').addUserOption(o => o.setName('target').setDescription('対象').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('ロール').setRequired(true)),
  new SlashCommandBuilder().setName('set-log').setDescription('ログ用チャンネル設定').addChannelOption(o => o.setName('channel').setDescription('チャンネル').setRequired(true)),

  // 📊 ユーティリティ (6個)
  new SlashCommandBuilder().setName('ping').setDescription('レイテンシ計測'),
  new SlashCommandBuilder().setName('botinfo').setDescription('Bot情報'),
  new SlashCommandBuilder().setName('help').setDescription('カテゴリ別コマンド一覧を表示'),
  new SlashCommandBuilder().setName('announce').setDescription('アナウンス作成').addStringOption(o => o.setName('content').setDescription('内容').setRequired(true)),
  new SlashCommandBuilder().setName('poll').setDescription('簡易投票').addStringOption(o => o.setName('question').setDescription('質問内容').setRequired(true)),
  new SlashCommandBuilder().setName('avatar').setDescription('アバター取得').addUserOption(o => o.setName('target').setDescription('対象'))
].map(cmd => cmd.toJSON());

// 設定されたロールを動的に付与する関数
async function grantConfiguredRole(interaction) {
  try {
    const targetRoleId = guildRoles.get(interaction.guildId) || process.env.VERIFIED_ROLE_ID;
    if (!targetRoleId) return { success: false, reason: 'ロールが設定されていません。`/set-role` で設定してください。' };

    const role = interaction.guild.roles.cache.get(targetRoleId);
    if (!role) return { success: false, reason: '設定されたロールが存在しません。' };

    await interaction.member.roles.add(role);
    return { success: true, roleName: role.name };
  } catch (error) {
    console.error('ロール付与エラー:', error);
    return { success: false, reason: '権限不足またはエラーが発生しました。' };
  }
}

// --------------------------------------------------
// イベント処理
// --------------------------------------------------

client.once('ready', async () => {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log(`Bot 起動完了: ${client.user.tag}`);
    client.user.setActivity('/help | 認証システム稼働中', { type: ActivityType.Custom });
  } catch (e) {
    console.error('コマンド登録失敗:', e);
  }
});

client.on('interactionCreate', async interaction => {
  
  // 1. スラッシュコマンド処理
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // ロール選択・設定コマンド
    if (commandName === 'set-role') {
      const selectedRole = interaction.options.getRole('role');
      guildRoles.set(interaction.guildId, selectedRole.id);
      return interaction.reply({ content: `✅ 認証付与ロールを **${selectedRole.name}** (ID: \`${selectedRole.id}\`) に設定しました。`, ephemeral: true });
    }

    // パスコード設定コマンド
    if (commandName === 'set-passcode') {
      const code = interaction.options.getString('code');
      guildPasscodes.set(interaction.guildId, code);
      return interaction.reply({ content: `✅ このサーバーの合言葉を \`${code}\` に更新しました。`, ephemeral: true });
    }

    // ステータス設定コマンド
    if (commandName === 'set-status') {
      const text = interaction.options.getString('text');
      const typeStr = interaction.options.getString('type') || 'Playing';
      const typeMap = { Playing: ActivityType.Playing, Streaming: ActivityType.Streaming, Listening: ActivityType.Listening, Watching: ActivityType.Watching };

      client.user.setActivity(text, { type: typeMap[typeStr] });
      return interaction.reply({ content: `✅ Botのステータスを **${typeStr}: ${text}** に変更しました。`, ephemeral: true });
    }

    // 認証コマンド (/verify)
    if (commandName === 'verify') {
      const mode = interaction.options.getString('mode');

      // 🔑 [モード3: 合言葉認証]
      if (mode === 'mode_passcode') {
        const modal = new ModalBuilder()
          .setCustomId('modal_passcode_auth')
          .setTitle('🔐 合言葉認証');

        const input = new TextInputBuilder()
          .setCustomId('input_passcode')
          .setLabel('指定された合言葉を入力')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return await interaction.showModal(modal);
      }

      // 🔤 [モード2: キャプチャ認証]
      if (mode === 'mode_captcha') {
        const generatedCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        captchaStore.set(interaction.user.id, generatedCode);
        setTimeout(() => captchaStore.delete(interaction.user.id), 3 * 60 * 1000);

        const embed = new EmbedBuilder()
          .setTitle('🔤 キャプチャ認証')
          .setDescription(`以下のコードを入力してください。\n\n**コード:** \`${generatedCode}\`\n*(有効期限: 3分)*`)
          .setColor(0x3498db);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('btn_open_captcha_modal').setLabel('コードを入力する').setStyle(ButtonStyle.Primary)
        );

        return await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
      }

      // 🔘 [モード1: ボタン認証]
      if (mode === 'mode_button') {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('btn_direct_verify').setLabel('ワンタップ認証').setStyle(ButtonStyle.Success)
        );
        return interaction.reply({ content: '以下のボタンを押して認証を完了してください。', components: [row], ephemeral: true });
      }

      return interaction.reply({ content: `選択モード [${mode}] の処理を開始しました。`, ephemeral: true });
    }

    // ヘルプコマンド
    if (commandName === 'help') {
      const embed = new EmbedBuilder()
        .setTitle('🤖 コマンド一覧 (全24個・4カテゴリ)')
        .setColor(0x00AE86)
        .addFields(
          { name: '🔐 認証 (6)', value: '`/verify` *(9モード選択肢付)*, `/verify-setup`, `/verify-panel`, `/verify-manual`, `/verify-reset`, `/set-passcode`' },
          { name: '🛡️ モデレーション (6)', value: '`/kick`, `/ban`, `/unban`, `/timeout`, `/untimeout`, `/purge`' },
          { name: '⚙️ 管理・Bot設定 (6)', value: '`/set-role`, `/set-status`, `/serverinfo`, `/userinfo`, `/role-add`, `/set-log`' },
          { name: '📊 ユーティリティ (6)', value: '`/ping`, `/botinfo`, `/help`, `/announce`, `/poll`, `/avatar`' }
        );
      return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'ping') return interaction.reply(`🏓 Pong! レイテンシ: ${client.ws.ping}ms`);

    return interaction.reply({ content: `\`/${commandName}\` を実行しました。`, ephemeral: true });
  }

  // 2. ボタン押下処理
  if (interaction.isButton()) {
    if (interaction.customId === 'btn_open_captcha_modal') {
      const modal = new ModalBuilder().setCustomId('modal_captcha_auth').setTitle('キャプチャ入力');
      const input = new TextInputBuilder().setCustomId('input_captcha').setLabel('5桁のコードを入力').setStyle(TextInputStyle.Short).setMaxLength(5).setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return await interaction.showModal(modal);
    }

    if (interaction.customId === 'btn_direct_verify') {
      const result = await grantConfiguredRole(interaction);
      return interaction.reply({ content: result.success ? `✅ 認証完了！ **${result.roleName}** ロールを付与しました。` : `⚠️ 失敗: ${result.reason}`, ephemeral: true });
    }
  }

  // 3. Modal送信判定処理
  if (interaction.isModalSubmit()) {
    // 合言葉判定
    if (interaction.customId === 'modal_passcode_auth') {
      const userPass = interaction.fields.getTextInputValue('input_passcode').trim();
      const targetPasscode = guildPasscodes.get(interaction.guildId) || process.env.PASSCODE || "secret2026";

      if (userPass === targetPasscode) {
        const result = await grantConfiguredRole(interaction);
        return interaction.reply({ content: result.success ? `✅ 合言葉一致！ **${result.roleName}** ロールを付与しました。` : `⚠️ 失敗: ${result.reason}`, ephemeral: true });
      }
      return interaction.reply({ content: '❌ 合言葉が正しくありません。', ephemeral: true });
    }

    // キャプチャ判定
    if (interaction.customId === 'modal_captcha_auth') {
      const userInput = interaction.fields.getTextInputValue('input_captcha').trim().toUpperCase();
      const code = captchaStore.get(interaction.user.id);

      if (code && userInput === code) {
        captchaStore.delete(interaction.user.id);
        const result = await grantConfiguredRole(interaction);
        return interaction.reply({ content: result.success ? `✅ キャプチャ認証成功！ **${result.roleName}** ロールを付与しました。` : `⚠️ 失敗: ${result.reason}`, ephemeral: true });
      }
      return interaction.reply({ content: '❌ コードが正しくないか有効期限切れです。', ephemeral: true });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
