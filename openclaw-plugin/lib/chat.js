/**
 * AICQ Chat Manager — Send/receive messages, group chat, file handling
 *
 * Enhanced: File/image messages received from users are saved to the
 * `userfiles` directory. After saving, a synthetic message is injected
 * into the AI dispatch pipeline that tells the agent about the local
 * file path so it can process the file (read, analyze, etc.).
 */
const { encryptMessage, decryptMessage } = require('./crypto');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ChatManager {
  constructor(identityManager, serverClient, db, uploadsDir, userfilesDir) {
    this.identity = identityManager;
    this.server = serverClient;
    this.db = db;
    this.uploadsDir = uploadsDir;
    this.userfilesDir = userfilesDir || path.join(path.dirname(uploadsDir), 'userfiles');
    this._onNewMessage = null;

    // Ensure userfiles directory exists
    fs.mkdirSync(this.userfilesDir, { recursive: true });

    // Incoming file chunk assembly state: fileId -> { meta, chunks }
    this._incomingFiles = new Map();

    // Listen for incoming messages via WS
    this.server.onMessage('relay', (data) => this._handleIncoming(data));
    this.server.onMessage('message', (data) => this._handleIncoming(data));
    this.server.onMessage('group_message', (data) => this._handleGroupIncoming(data));
    this.server.onMessage('handshake_initiate', (data) => this._handleHandshakeRequest(data));
    this.server.onMessage('presence', (data) => this._handlePresence(data));
    this.server.onMessage('file_chunk', (data) => this._handleFileChunk(data));
    this.server.onMessage('file', (data) => this._handleFileMessage(data));
    this.server.onMessage('image', (data) => this._handleFileMessage(data));
    this.server.onMessage('stream_chunk', (data) => this._handleStreamChunk(data));
    this.server.onMessage('stream_end', (data) => this._handleStreamEnd(data));
  }

  setOnNewMessage(callback) {
    this._onNewMessage = callback;
  }

  // ─── Send Messages ────────────────────────────────────────────────

  async sendMessage(agentId, targetId, content, { type = 'text', isGroup = false, mentions = [], file_url = null, file_name = null, local_path = null } = {}) {
    const identity = this.identity.loadAgent(agentId);

    if (isGroup) {
      // Group message via WebSocket
      const sent = this.server.sendWS({
        type: 'group_message',
        groupId: targetId,
        content,
        msgType: type,
        mentions,
      });

      // Save locally
      const msg = this.db.saveMessage({
        agent_id: agentId,
        target_id: targetId,
        from_id: agentId,
        to_id: targetId,
        type,
        content,
        file_url,
        file_name,
        local_path,
        is_group: 1,
        mentions,
        status: sent ? 'sent' : 'pending',
      });

      if (this._onNewMessage) this._onNewMessage(msg);
      return msg;
    }

    // Direct message
    // Try to encrypt if we have a session key
    const session = this.db.loadSession(agentId, targetId);
    let payload = content;
    if (session && session.session_key) {
      try {
        payload = encryptMessage(content, session.session_key);
      } catch (e) {
        console.error('[Chat] Encryption failed, sending plaintext:', e.message);
      }
    }

    // Send via WebSocket relay
    const sent = this.server.sendWS({
      type: 'relay',
      targetId: targetId,
      payload,
    });

    // Also try REST fallback
    if (!sent) {
      try {
        await this.server._request('POST', '/messages/send', {
          targetId,
          payload,
        });
      } catch (e) {
        // Queue offline
        this.db.enqueueOffline({
          agent_id: agentId,
          target_id: targetId,
          data: JSON.stringify({ type: 'relay', targetId, payload }),
        });
      }
    }

    // Save locally
    const msg = this.db.saveMessage({
      agent_id: agentId,
      target_id: targetId,
      from_id: agentId,
      to_id: targetId,
      type,
      content,
      file_url,
      file_name,
      local_path,
      is_group: 0,
      mentions,
      status: sent ? 'sent' : 'pending',
    });

    // Update session message count
    if (session) {
      this.db.incrementSessionMessageCount(agentId, targetId);
    }

    if (this._onNewMessage) this._onNewMessage(msg);
    return msg;
  }

  // ─── Receive Messages ─────────────────────────────────────────────

  _handleIncoming(data) {
    const agentId = this.server.currentAgentId;
    if (!agentId) return;

    const fromId = data.fromId || data.from;
    let content = data.payload || data.data || '';
    const msgType = data.msgType || data.type || 'text';

    // Try to decrypt if we have a session key
    const session = this.db.loadSession(agentId, fromId);
    if (session && session.session_key && typeof content === 'string') {
      try {
        content = decryptMessage(content, session.session_key);
      } catch (e) {
        // Might be plaintext, keep as is
      }
    }

    // Detect if this is a file or image message
    const isFileMessage = this._isFileMessage(msgType, content, data);
    let localFilePath = null;
    let originalFileName = null;

    if (isFileMessage) {
      const fileResult = this._saveIncomingFileToUserfiles(agentId, fromId, content, data);
      if (fileResult) {
        localFilePath = fileResult.localPath;
        originalFileName = fileResult.originalName;
      }
    }

    // Save the original message
    const msg = this.db.saveMessage({
      agent_id: agentId,
      target_id: fromId,
      from_id: fromId,
      to_id: agentId,
      type: isFileMessage ? (this._isImageMessage(msgType, content, data) ? 'image' : 'file') : 'text',
      content: typeof content === 'string' ? content : JSON.stringify(content),
      file_url: data.file_url || data.fileUrl || null,
      file_name: originalFileName || data.file_name || data.fileName || null,
      local_path: localFilePath,
      is_group: 0,
      status: 'delivered',
    });

    if (this._onNewMessage) this._onNewMessage(msg);

    // If this was a file/image message, also inject a synthetic message
    // telling the AI agent about the local file path
    if (isFileMessage && localFilePath && this._onNewMessage) {
      const isImage = this._isImageMessage(msgType, content, data);
      const fileType = isImage ? '图片' : '文件';
      const syntheticMsg = {
        agent_id: agentId,
        target_id: fromId,
        from_id: fromId,
        to_id: agentId,
        type: 'text',
        content: `[用户发送了${fileType}] ${originalFileName || '未知文件名'}\n本地路径: ${localFilePath}\n请处理该${fileType}。`,
        is_group: 0,
        status: 'delivered',
        _synthetic: true,  // Mark as synthetic so AI dispatch can handle it
        _original_msg_id: msg.message_id || msg.id,
      };
      this._onNewMessage(syntheticMsg);
    }
  }

  _handleGroupIncoming(data) {
    const agentId = this.server.currentAgentId;
    if (!agentId) return;

    const fromId = data.fromId;
    const groupId = data.groupId;

    // Check silent mode
    const silent = this.db.getGroupSilentMode(agentId, groupId);
    const mentions = data.mentions || [];
    const isMentioned = mentions.includes(agentId) || mentions.includes('all');

    const content = data.content || '';
    const msgType = data.msgType || 'text';

    // Detect file/image in group message
    const isFileMessage = this._isFileMessage(msgType, content, data);
    let localFilePath = null;
    let originalFileName = null;

    if (isFileMessage) {
      const fileResult = this._saveIncomingFileToUserfiles(agentId, fromId, content, data);
      if (fileResult) {
        localFilePath = fileResult.localPath;
        originalFileName = fileResult.originalName;
      }
    }

    const msg = this.db.saveMessage({
      agent_id: agentId,
      target_id: groupId,
      from_id: fromId,
      to_id: groupId,
      type: isFileMessage ? (this._isImageMessage(msgType, content, data) ? 'image' : 'file') : (data.msgType || 'text'),
      content,
      file_url: data.file_url || data.fileUrl || null,
      file_name: originalFileName || data.file_name || data.fileName || null,
      local_path: localFilePath,
      is_group: 1,
      mentions,
      status: (silent && !isMentioned) ? 'silent' : 'delivered',
    });

    if (this._onNewMessage) this._onNewMessage(msg);

    // Inject synthetic message for group file messages
    if (isFileMessage && localFilePath && this._onNewMessage && (isMentioned || !silent)) {
      const isImage = this._isImageMessage(msgType, content, data);
      const fileType = isImage ? '图片' : '文件';
      const syntheticMsg = {
        agent_id: agentId,
        target_id: groupId,
        from_id: fromId,
        to_id: groupId,
        type: 'text',
        content: `[群组中用户发送了${fileType}] ${originalFileName || '未知文件名'}\n本地路径: ${localFilePath}\n请处理该${fileType}。`,
        is_group: 1,
        status: 'delivered',
        _synthetic: true,
        _original_msg_id: msg.message_id || msg.id,
      };
      this._onNewMessage(syntheticMsg);
    }
  }

  _handleHandshakeRequest(data) {
    const agentId = this.server.currentAgentId;
    if (!agentId) return;

    this.db.savePendingRequest({
      agent_id: agentId,
      session_id: data.sessionId || crypto.randomUUID(),
      requester_id: data.requesterId || data.from,
      requester_public_key: data.requesterPublicKey || data.exchangePublicKey || '',
    });
  }

  _handlePresence(data) {
    const agentId = this.server.currentAgentId;
    if (!agentId) return;

    const friendId = data.nodeId;
    const isOnline = data.online === true || data.status === 'online';
    this.db.updateFriendOnline(agentId, friendId, isOnline);
  }

  _handleFileMessage(data) {
    // Handle explicit file/image type WS messages
    const agentId = this.server.currentAgentId;
    if (!agentId) return;

    const fromId = data.fromId || data.from;
    const content = data.content || data.data || '';
    const isImage = data.type === 'image' || this._isImageMessage(data.type, content, data);

    let localFilePath = null;
    let originalFileName = null;

    // If the file data is inline (base64), save it
    if (data.file_data || data.data && this._isBase64Data(data.data)) {
      const fileResult = this._saveBase64FileToUserfiles(agentId, fromId, data);
      if (fileResult) {
        localFilePath = fileResult.localPath;
        originalFileName = fileResult.originalName;
      }
    } else if (data.file_url || data.fileUrl) {
      // Download file from URL and save locally
      const fileResult = this._saveUrlFileToUserfiles(agentId, fromId, data);
      if (fileResult) {
        localFilePath = fileResult.localPath;
        originalFileName = fileResult.originalName;
      }
    }

    // Save message
    const msg = this.db.saveMessage({
      agent_id: agentId,
      target_id: fromId,
      from_id: fromId,
      to_id: agentId,
      type: isImage ? 'image' : 'file',
      content,
      file_url: data.file_url || data.fileUrl || null,
      file_name: originalFileName || data.file_name || data.fileName || null,
      local_path: localFilePath,
      is_group: 0,
      status: 'delivered',
    });

    if (this._onNewMessage) this._onNewMessage(msg);

    // Inject synthetic message
    if (localFilePath && this._onNewMessage) {
      const fileType = isImage ? '图片' : '文件';
      const syntheticMsg = {
        agent_id: agentId,
        target_id: fromId,
        from_id: fromId,
        to_id: agentId,
        type: 'text',
        content: `[用户发送了${fileType}] ${originalFileName || '未知文件名'}\n本地路径: ${localFilePath}\n请处理该${fileType}。`,
        is_group: 0,
        status: 'delivered',
        _synthetic: true,
        _original_msg_id: msg.message_id || msg.id,
      };
      this._onNewMessage(syntheticMsg);
    }
  }

  _handleFileChunk(data) {
    // File chunk handling — assemble in userfiles dir
    const agentId = this.server.currentAgentId;
    if (!agentId) return;

    const chunkData = data.data || data;
    const fileId = chunkData.fileId || data.fileId;

    if (!fileId) {
      console.log('[Chat] File chunk without fileId from', data.from);
      return;
    }

    // Initialize incoming transfer if needed
    if (!this._incomingFiles.has(fileId)) {
      this._incomingFiles.set(fileId, {
        chunks: new Map(),
        meta: null,
        fromId: data.fromId || data.from,
      });
    }

    const transfer = this._incomingFiles.get(fileId);

    // If this is a file-info message
    if (chunkData.type === 'file-info') {
      transfer.meta = chunkData;
      return;
    }

    // Store the chunk
    transfer.chunks.set(chunkData.index, chunkData);

    // Check if all chunks received
    if (transfer.meta && transfer.chunks.size >= transfer.meta.totalChunks) {
      this._assembleAndNotify(agentId, fileId, transfer);
    }
  }

  /**
   * Assemble received file chunks into a complete file in userfiles,
   * then notify the AI agent about the local file path.
   */
  _assembleAndNotify(agentId, fileId, transfer) {
    const { meta, chunks, fromId } = transfer;

    try {
      const sortedChunks = Array.from(chunks.entries())
        .sort((a, b) => a[0] - b[0]);

      const buffers = [];
      for (const [index, chunk] of sortedChunks) {
        if (chunk.encrypted) {
          // For now, try to use raw data
          buffers.push(Buffer.from(chunk.data, 'base64'));
        } else {
          buffers.push(Buffer.from(chunk.data, 'base64'));
        }
      }

      const fileBuffer = Buffer.concat(buffers);
      const originalName = meta.fileName || `file_${fileId}`;
      const ext = path.extname(originalName) || '.bin';

      // Save to userfiles with timestamp prefix for uniqueness
      const timestamp = Date.now();
      const safeName = `${timestamp}_${fileId.substring(0, 8)}${ext}`;
      const localPath = path.join(this.userfilesDir, safeName);
      fs.writeFileSync(localPath, fileBuffer);

      const isImage = /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(ext);

      // Save to chat history
      const msg = this.db.saveMessage({
        agent_id: agentId,
        target_id: fromId,
        from_id: fromId,
        to_id: agentId,
        type: isImage ? 'image' : 'file',
        content: JSON.stringify({
          fileId,
          fileName: originalName,
          fileSize: meta.fileSize,
          localPath,
        }),
        file_name: originalName,
        local_path: localPath,
        is_group: 0,
        status: 'delivered',
      });

      console.log(`[Chat] File assembled: ${originalName} -> ${localPath}`);

      if (this._onNewMessage) {
        this._onNewMessage(msg);

        // Inject synthetic message
        const fileType = isImage ? '图片' : '文件';
        const syntheticMsg = {
          agent_id: agentId,
          target_id: fromId,
          from_id: fromId,
          to_id: agentId,
          type: 'text',
          content: `[用户发送了${fileType}] ${originalName}\n本地路径: ${localPath}\n文件大小: ${meta.fileSize} 字节\n请处理该${fileType}。`,
          is_group: 0,
          status: 'delivered',
          _synthetic: true,
          _original_msg_id: msg.message_id || msg.id,
        };
        this._onNewMessage(syntheticMsg);
      }
    } catch (e) {
      console.error(`[Chat] File assembly failed for ${fileId}:`, e.message);
    } finally {
      this._incomingFiles.delete(fileId);
    }
  }

  _handleStreamChunk(data) {
    // Incoming streaming chunk from another agent
    const agentId = this.server.currentAgentId;
    if (!agentId) return;

    const fromId = data.from;
    const chunkType = data.chunkType || 'text';
    const chunkData = data.data;

    // Notify callback so OpenClaw agent can process streaming input
    if (this._onNewMessage) {
      this._onNewMessage({
        type: 'stream_chunk',
        from_id: fromId,
        chunk_type: chunkType,
        data: chunkData,
      });
    }
    console.log('[Chat] Stream chunk from', fromId, 'type:', chunkType);
  }

  _handleStreamEnd(data) {
    // Incoming stream end signal from another agent
    const agentId = this.server.currentAgentId;
    if (!agentId) return;

    const fromId = data.from;
    const messageId = data.messageId || '';

    // Notify callback so OpenClaw agent knows stream is complete
    if (this._onNewMessage) {
      this._onNewMessage({
        type: 'stream_end',
        from_id: fromId,
        message_id: messageId,
      });
    }
    console.log('[Chat] Stream end from', fromId, 'messageId:', messageId);
  }

  // ─── Chat History ─────────────────────────────────────────────────

  getHistory(agentId, targetId, { limit = 50, before = null } = {}) {
    return this.db.getChatHistory(agentId, targetId, { limit, before });
  }

  deleteMessage(agentId, messageId) {
    this.db.deleteMessage(agentId, messageId);
  }

  // ─── File Upload ──────────────────────────────────────────────────

  async handleFileUpload(agentId, targetId, file, isGroup = false) {
    const fileId = crypto.randomUUID();
    const ext = path.extname(file.originalname || '.bin');
    const fileName = `${fileId}${ext}`;
    const filePath = path.join(this.uploadsDir, fileName);
    fs.writeFileSync(filePath, file.buffer);

    const isImage = /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(ext);

    // Send message with file reference
    const msg = await this.sendMessage(agentId, targetId, isImage ? '[图片]' : `[文件] ${file.originalname}`, {
      type: isImage ? 'image' : 'file',
      isGroup,
      file_url: `/api/files/${fileName}`,
      file_name: file.originalname,
      local_path: filePath,
    });

    return msg;
  }

  // ─── Userfile Management ─────────────────────────────────────────

  /**
   * Save an uploaded file from a user to the userfiles directory.
   * This is called when files are received via the HTTP upload API
   * and should be processed by the AI agent.
   */
  async handleUserFileUpload(agentId, fromId, file, isGroup = false) {
    const fileId = crypto.randomUUID();
    const ext = path.extname(file.originalname || '.bin');
    const timestamp = Date.now();
    const safeName = `${timestamp}_${fileId.substring(0, 8)}${ext}`;
    const localPath = path.join(this.userfilesDir, safeName);

    fs.writeFileSync(localPath, file.buffer);

    const isImage = /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(ext);
    const originalName = file.originalname || safeName;

    // Save to chat history
    const msg = this.db.saveMessage({
      agent_id: agentId,
      target_id: fromId,
      from_id: fromId,
      to_id: agentId,
      type: isImage ? 'image' : 'file',
      content: `[${isImage ? '图片' : '文件'}] ${originalName}`,
      file_name: originalName,
      local_path: localPath,
      is_group: isGroup ? 1 : 0,
      status: 'delivered',
    });

    if (this._onNewMessage) {
      this._onNewMessage(msg);

      // Inject synthetic message for AI agent
      const fileType = isImage ? '图片' : '文件';
      const syntheticMsg = {
        agent_id: agentId,
        target_id: fromId,
        from_id: fromId,
        to_id: agentId,
        type: 'text',
        content: `[用户发送了${fileType}] ${originalName}\n本地路径: ${localPath}\n文件大小: ${file.size || file.buffer?.length || 0} 字节\n请处理该${fileType}。`,
        is_group: isGroup ? 1 : 0,
        status: 'delivered',
        _synthetic: true,
        _original_msg_id: msg.message_id || msg.id,
      };
      this._onNewMessage(syntheticMsg);
    }

    return { msg, localPath, originalName };
  }

  // ─── Private Helpers ──────────────────────────────────────────────

  /**
   * Check if a message represents a file/image based on type and content.
   */
  _isFileMessage(msgType, content, data) {
    // Check explicit message type
    if (['file', 'image', 'file_chunk'].includes(msgType)) return true;
    if (['file', 'image'].includes(data.type)) return true;

    // Check for file metadata in content
    if (typeof content === 'string') {
      try {
        const parsed = JSON.parse(content);
        if (parsed.type === 'file-info' || parsed.fileId || parsed.fileName || parsed.localPath) {
          return true;
        }
      } catch (e) {
        // Not JSON
      }
    }

    // Check for file_url or file data
    if (data.file_url || data.fileUrl || data.file_data || data.fileData) return true;

    // Check for known file markers in text content
    if (typeof content === 'string' && (
      content.startsWith('[文件]') ||
      content.startsWith('[图片]') ||
      content.startsWith('[File]') ||
      content.startsWith('[Image]')
    )) {
      return true;
    }

    return false;
  }

  /**
   * Check if a message is specifically an image (vs other file types).
   */
  _isImageMessage(msgType, content, data) {
    if (msgType === 'image' || data.type === 'image') return true;

    // Check file extension in filename
    const fileName = data.file_name || data.fileName || '';
    if (/\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(fileName)) return true;

    // Check content markers
    if (typeof content === 'string' && content.startsWith('[图片]')) return true;

    return false;
  }

  /**
   * Save an incoming file to the userfiles directory.
   * Handles various formats: inline base64, URL references, file-info JSON.
   */
  _saveIncomingFileToUserfiles(agentId, fromId, content, data) {
    try {
      const fileId = crypto.randomUUID();
      const timestamp = Date.now();

      // Try to extract file info from the message
      let parsed = null;
      if (typeof content === 'string') {
        try { parsed = JSON.parse(content); } catch (e) {}
      }

      // Case 1: file-info with chunked data (already assembled elsewhere)
      if (parsed && parsed.localPath) {
        // File is already on disk, just reference it
        return {
          localPath: parsed.localPath,
          originalName: parsed.fileName || path.basename(parsed.localPath),
        };
      }

      // Case 2: Base64 data inline
      if (data.file_data || data.fileData || (parsed && parsed.data && this._isBase64Data(parsed.data))) {
        return this._saveBase64FileToUserfiles(agentId, fromId, {
          ...data,
          file_data: data.file_data || data.fileData || (parsed && parsed.data),
          file_name: data.file_name || data.fileName || (parsed && parsed.fileName) || 'file.bin',
        });
      }

      // Case 3: URL reference — download and save
      if (data.file_url || data.fileUrl || (parsed && parsed.fileUrl)) {
        return this._saveUrlFileToUserfiles(agentId, fromId, {
          ...data,
          file_url: data.file_url || data.fileUrl || (parsed && parsed.fileUrl),
          file_name: data.file_name || data.fileName || (parsed && parsed.fileName) || 'file.bin',
        });
      }

      // Case 4: Text-based file marker like [文件] filename or [图片] filename
      if (typeof content === 'string' && (
        content.startsWith('[文件]') ||
        content.startsWith('[图片]') ||
        content.startsWith('[File]') ||
        content.startsWith('[Image]')
      )) {
        const originalName = content.replace(/^\[(文件|图片|File|Image)\]\s*/, '').trim() || 'unknown';
        const ext = path.extname(originalName) || (content.includes('图片') || content.includes('Image') ? '.png' : '.bin');
        const safeName = `${timestamp}_${fileId.substring(0, 8)}${ext}`;
        const localPath = path.join(this.userfilesDir, safeName);

        // Create a placeholder file — the actual content may come via chunks
        // or may already be in the uploads dir
        const uploadsPath = path.join(this.uploadsDir, originalName);
        if (fs.existsSync(uploadsPath)) {
          fs.copyFileSync(uploadsPath, localPath);
          console.log(`[Chat] Copied user file: ${originalName} -> ${localPath}`);
          return { localPath, originalName };
        }

        // No actual file data yet — save a placeholder
        fs.writeFileSync(localPath, Buffer.alloc(0));
        console.log(`[Chat] Created placeholder for user file: ${localPath}`);
        return { localPath, originalName };
      }

      return null;
    } catch (e) {
      console.error('[Chat] Failed to save incoming file to userfiles:', e.message);
      return null;
    }
  }

  /**
   * Save a base64-encoded file to userfiles.
   */
  _saveBase64FileToUserfiles(agentId, fromId, data) {
    try {
      const fileId = crypto.randomUUID();
      const timestamp = Date.now();
      const base64Data = data.file_data || data.fileData || data.data;
      const originalName = data.file_name || data.fileName || 'file.bin';

      if (!base64Data) return null;

      // Strip data URL prefix if present (e.g., "data:image/png;base64,")
      const base64Clean = base64Data.replace(/^data:[^;]+;base64,/, '');
      const fileBuffer = Buffer.from(base64Clean, 'base64');

      const ext = path.extname(originalName) || this._inferExtFromData(base64Data);
      const safeName = `${timestamp}_${fileId.substring(0, 8)}${ext}`;
      const localPath = path.join(this.userfilesDir, safeName);

      fs.writeFileSync(localPath, fileBuffer);
      console.log(`[Chat] Saved base64 user file: ${originalName} -> ${localPath} (${fileBuffer.length} bytes)`);

      return { localPath, originalName };
    } catch (e) {
      console.error('[Chat] Failed to save base64 file:', e.message);
      return null;
    }
  }

  /**
   * Download a file from URL and save to userfiles.
   */
  _saveUrlFileToUserfiles(agentId, fromId, data) {
    try {
      const fileId = crypto.randomUUID();
      const timestamp = Date.now();
      const fileUrl = data.file_url || data.fileUrl;
      const originalName = data.file_name || data.fileName || path.basename(fileUrl || 'file.bin');

      // For local server URLs, resolve the local path directly
      if (fileUrl && fileUrl.startsWith('/api/files/')) {
        const fileName = path.basename(fileUrl);
        const uploadsPath = path.join(this.uploadsDir, fileName);
        if (fs.existsSync(uploadsPath)) {
          const ext = path.extname(originalName) || path.extname(uploadsPath);
          const safeName = `${timestamp}_${fileId.substring(0, 8)}${ext}`;
          const localPath = path.join(this.userfilesDir, safeName);
          fs.copyFileSync(uploadsPath, localPath);
          console.log(`[Chat] Copied local URL file: ${fileUrl} -> ${localPath}`);
          return { localPath, originalName };
        }
      }

      // For remote URLs, we'd need async download — log and skip for now
      console.log(`[Chat] Remote file URL (async download not yet supported): ${fileUrl}`);
      const ext = path.extname(originalName) || '.bin';
      const safeName = `${timestamp}_${fileId.substring(0, 8)}${ext}`;
      const localPath = path.join(this.userfilesDir, safeName);

      // Save a placeholder with the URL reference
      fs.writeFileSync(localPath, JSON.stringify({
        type: 'url_reference',
        url: fileUrl,
        originalName,
        timestamp,
      }));
      return { localPath, originalName };
    } catch (e) {
      console.error('[Chat] Failed to save URL file:', e.message);
      return null;
    }
  }

  /**
   * Check if a string looks like base64 data.
   */
  _isBase64Data(str) {
    if (typeof str !== 'string') return false;
    if (str.startsWith('data:')) return true;
    // Quick heuristic: long string with only base64 chars
    if (str.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(str.substring(0, 200))) return true;
    return false;
  }

  /**
   * Infer file extension from base64 data URL prefix.
   */
  _inferExtFromData(data) {
    if (typeof data !== 'string') return '.bin';
    const mimeMatch = data.match(/^data:([^;]+);/);
    if (mimeMatch) {
      const mime = mimeMatch[1];
      const mimeToExt = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/svg+xml': '.svg',
        'image/bmp': '.bmp',
        'application/pdf': '.pdf',
        'text/plain': '.txt',
        'application/json': '.json',
        'application/zip': '.zip',
        'audio/mpeg': '.mp3',
        'video/mp4': '.mp4',
      };
      return mimeToExt[mime] || '.bin';
    }
    return '.bin';
  }
}

module.exports = ChatManager;
