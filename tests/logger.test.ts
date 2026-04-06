import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createLogger,
  setGlobalLogLevel,
  getGlobalLogLevel,
  log,
  type LogLevel,
} from '../src/core/logger.js';

describe('logger', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setGlobalLogLevel('info');
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    setGlobalLogLevel('info');
  });

  describe('log levels', () => {
    it('should log info messages at info level', () => {
      const logger = createLogger('test');
      logger.info('hello');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[test] hello');
    });

    it('should not log debug messages at info level', () => {
      const logger = createLogger('test');
      logger.debug('debug msg');
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('should log debug messages at debug level', () => {
      setGlobalLogLevel('debug');
      const logger = createLogger('test');
      logger.debug('debug msg');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[test] debug msg');
    });

    it('should log warn messages with prefix', () => {
      const logger = createLogger('test');
      logger.warn('warning');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[test] WARN: warning');
    });

    it('should log error messages with prefix', () => {
      const logger = createLogger('test');
      logger.error('failure');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[test] ERROR: failure');
    });

    it('should suppress all messages at silent level', () => {
      setGlobalLogLevel('silent');
      const logger = createLogger('test');
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('should only log errors at error level', () => {
      setGlobalLogLevel('error');
      const logger = createLogger('test');
      logger.info('info msg');
      logger.warn('warn msg');
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      logger.error('error msg');
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('global level', () => {
    it('should get and set global log level', () => {
      expect(getGlobalLogLevel()).toBe('info');
      setGlobalLogLevel('debug');
      expect(getGlobalLogLevel()).toBe('debug');
    });

    it('should affect all loggers when changed', () => {
      const logger1 = createLogger('a');
      const logger2 = createLogger('b');
      setGlobalLogLevel('error');
      logger1.info('test');
      logger2.info('test');
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe('child loggers', () => {
    it('should create child with combined prefix', () => {
      const parent = createLogger('parent');
      const child = parent.child('child');
      child.info('message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[parent:child] message');
    });

    it('should support multi-level nesting', () => {
      const root = createLogger('a');
      const child = root.child('b').child('c');
      child.info('deep');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[a:b:c] deep');
    });
  });

  describe('no prefix', () => {
    it('should work without prefix', () => {
      const logger = createLogger();
      logger.info('bare message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('bare message');
    });
  });

  describe('extra arguments', () => {
    it('should pass additional args to console.error', () => {
      const logger = createLogger('test');
      logger.info('data:', { key: 'val' });
      expect(consoleErrorSpy).toHaveBeenCalledWith('[test] data:', { key: 'val' });
    });
  });

  describe('default log instance', () => {
    it('should have harness prefix', () => {
      log.info('boot complete');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[harness] boot complete');
    });
  });

  describe('setLevel on logger instance', () => {
    it('should set global level via logger', () => {
      const logger = createLogger('test');
      logger.setLevel('warn');
      expect(getGlobalLogLevel()).toBe('warn');
    });

    it('should get current level', () => {
      const logger = createLogger('test');
      setGlobalLogLevel('debug');
      expect(logger.getLevel()).toBe('debug');
    });
  });
});
