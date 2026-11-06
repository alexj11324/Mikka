import { defineHandler } from 'nitro'
import api from '../src/index'
export default defineHandler(event => api.fetch(event.req))
